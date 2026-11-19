"""Vizuális és viselkedési regressziós ellenőrzés saját webappokhoz.

Minta: Craft Anything "check" lépése (3 szélesség, layout + SSIM alapú hasonlóság,
küszöb), kiegészítve viselkedési ellenőrzéssel, mert a pixelösszevetés nem veszi
észre a működésképtelen gombot vagy linket.

Használat:
  python visual_check.py --base-url https://example.app --pages / /pricing --update-baseline
  python visual_check.py --base-url https://example.app --pages / /pricing
Kilépési kód: 0 = minden rendben, 1 = eltérés vagy hiba, 2 = hibás paraméter.
"""
import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple
from urllib.parse import urljoin, urlparse

import numpy as np
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

TILE = 16
TILE_TOLERANCE = 24.0
MAX_HEIGHT = 6000
SSIM_WINDOW = 8
C1 = (0.01 * 255) ** 2
C2 = (0.03 * 255) ** 2


@dataclass
class PageResult:
    page: str
    width: int
    screenshot: str
    score: float = None
    layout: float = None
    perceptual: float = None
    size_mismatch: bool = False
    diff_image: str = None
    console_errors: List[str] = field(default_factory=list)
    page_errors: List[str] = field(default_factory=list)
    failed_requests: List[str] = field(default_factory=list)
    broken_links: List[str] = field(default_factory=list)
    unnamed_controls: int = 0
    horizontal_overflow: bool = False

    @property
    def behaviour_ok(self) -> bool:
        return not (
            self.console_errors
            or self.page_errors
            or self.failed_requests
            or self.broken_links
            or self.horizontal_overflow
        )


def slug(page: str) -> str:
    s = page.strip("/").replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "-")
    return s or "home"


def load_gray_rgb(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    img = Image.open(path).convert("RGB")
    rgb = np.asarray(img, dtype=np.float64)
    gray = rgb @ np.array([0.299, 0.587, 0.114])
    return rgb, gray


def box_mean(a: np.ndarray, k: int) -> np.ndarray:
    pad = np.pad(a, ((1, 0), (1, 0)), mode="constant")
    c = pad.cumsum(0).cumsum(1)
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s / (k * k)


def ssim(x: np.ndarray, y: np.ndarray) -> float:
    if min(x.shape) < SSIM_WINDOW:
        return 1.0 if np.allclose(x, y) else 0.0
    mx, my = box_mean(x, SSIM_WINDOW), box_mean(y, SSIM_WINDOW)
    vx = box_mean(x * x, SSIM_WINDOW) - mx * mx
    vy = box_mean(y * y, SSIM_WINDOW) - my * my
    cxy = box_mean(x * y, SSIM_WINDOW) - mx * my
    num = (2 * mx * my + C1) * (2 * cxy + C2)
    den = (mx * mx + my * my + C1) * (vx + vy + C2)
    return float(np.clip((num / den).mean(), 0.0, 1.0))


def tile_means(rgb: np.ndarray) -> np.ndarray:
    h = (rgb.shape[0] // TILE) * TILE
    w = (rgb.shape[1] // TILE) * TILE
    t = rgb[:h, :w].reshape(h // TILE, TILE, w // TILE, TILE, 3)
    return t.mean(axis=(1, 3))


def compare(baseline: Path, current: Path, diff_out: Path) -> Tuple[float, float, float, bool]:
    b_rgb, b_gray = load_gray_rgb(baseline)
    c_rgb, c_gray = load_gray_rgb(current)
    mismatch = b_rgb.shape != c_rgb.shape
    h = min(b_rgb.shape[0], c_rgb.shape[0])
    w = min(b_rgb.shape[1], c_rgb.shape[1])
    b_rgb, c_rgb = b_rgb[:h, :w], c_rgb[:h, :w]
    b_gray, c_gray = b_gray[:h, :w], c_gray[:h, :w]
    bt, ct = tile_means(b_rgb), tile_means(c_rgb)
    tile_diff = np.abs(bt - ct).max(axis=2) > TILE_TOLERANCE
    layout = 1.0 - float(tile_diff.mean()) if tile_diff.size else 1.0
    perceptual = ssim(b_gray, c_gray)
    score = (layout + perceptual) * 50.0
    if mismatch:
        height_ratio = min(b_rgb.shape[0], c_rgb.shape[0]) / max(
            Image.open(baseline).height, Image.open(current).height
        )
        score *= height_ratio
    if tile_diff.any():
        img = Image.fromarray(c_rgb.astype(np.uint8)).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        for ty, tx in zip(*np.nonzero(tile_diff)):
            x0, y0 = tx * TILE, ty * TILE
            draw.rectangle([x0, y0, x0 + TILE - 1, y0 + TILE - 1], fill=(255, 0, 0, 90))
        Image.alpha_composite(img, overlay).convert("RGB").save(diff_out)
    return round(score, 2), round(layout, 4), round(perceptual, 4), mismatch


def same_origin(url: str, base: str) -> bool:
    return urlparse(url).netloc == urlparse(base).netloc


def capture(context, base_url: str, page_path: str, width: int, out: Path, check_links: bool) -> PageResult:
    url = urljoin(base_url if base_url.endswith("/") else base_url + "/", page_path.lstrip("/"))
    page = context.new_page()
    page.set_viewport_size({"width": width, "height": 900})
    result = PageResult(page=page_path, width=width, screenshot=str(out))
    page.on("console", lambda m: result.console_errors.append(m.text[:300]) if m.type == "error" else None)
    page.on("pageerror", lambda e: result.page_errors.append(str(e)[:300]))
    page.on(
        "response",
        lambda r: result.failed_requests.append(f"{r.status} {r.url[:200]}")
        if r.status >= 400 and same_origin(r.url, base_url)
        else None,
    )
    page.goto(url, wait_until="networkidle", timeout=45000)
    page.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}")
    page.wait_for_timeout(500)
    height = min(page.evaluate("document.documentElement.scrollHeight"), MAX_HEIGHT)
    page.set_viewport_size({"width": width, "height": max(900, height)})
    page.wait_for_timeout(300)
    page.screenshot(path=str(out), full_page=False)
    result.horizontal_overflow = bool(
        page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    )
    result.unnamed_controls = int(
        page.evaluate(
            """() => [...document.querySelectorAll('button, a[href], [role=button]')]
            .filter(e => e.offsetParent !== null)
            .filter(e => !(e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim()
                         && !e.querySelector('img[alt]:not([alt=""]), svg title'))
            .length"""
        )
    )
    if check_links:
        hrefs = page.evaluate(
            "() => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href))]"
        )
        for href in hrefs:
            if not href.startswith("http") or not same_origin(href, base_url):
                continue
            try:
                resp = context.request.get(href.split("#")[0], timeout=20000)
                if resp.status >= 400:
                    result.broken_links.append(f"{resp.status} {href[:200]}")
            except Exception as exc:
                result.broken_links.append(f"hiba {href[:200]}: {str(exc)[:100]}")
    page.close()
    return result


def write_report(results: List[PageResult], args, out_dir: Path) -> bool:
    ok = True
    lines = [
        f"# Vizuális és viselkedési ellenőrzés – {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        f"Cél: {args.base_url} | Küszöb: {args.threshold}% | Szélességek: {', '.join(map(str, args.widths))}",
        "",
        "| Oldal | Szélesség | Hasonlóság | Layout | SSIM | Viselkedés |",
        "|---|---|---|---|---|---|",
    ]
    for r in results:
        visual_ok = r.score is None or r.score >= args.threshold
        ok = ok and visual_ok and r.behaviour_ok
        score = "baseline mentve" if r.score is None else f"{r.score}%{' ⚠️ méreteltérés' if r.size_mismatch else ''}"
        lines.append(
            f"| {r.page} | {r.width} | {'✅' if visual_ok else '❌'} {score} | "
            f"{'' if r.layout is None else r.layout} | {'' if r.perceptual is None else r.perceptual} | "
            f"{'✅' if r.behaviour_ok else '❌'} |"
        )
    lines.append("")
    for r in results:
        problems = []
        problems += [f"konzolhiba: {e}" for e in r.console_errors]
        problems += [f"JS kivétel: {e}" for e in r.page_errors]
        problems += [f"sikertelen kérés: {e}" for e in r.failed_requests]
        problems += [f"törött link: {e}" for e in r.broken_links]
        if r.horizontal_overflow:
            problems.append("vízszintes túlcsordulás (oldalra görgethető)")
        if r.unnamed_controls:
            problems.append(f"{r.unnamed_controls} felirat nélküli gomb/link (akadálymentesség, nem buktat)")
        if r.diff_image:
            problems.append(f"eltéréstérkép: {r.diff_image}")
        if problems:
            lines.append(f"## {r.page} @ {r.width}px")
            lines += [f"- {p}" for p in problems]
            lines.append("")
    lines.append(f"**Eredmény: {'RENDBEN' if ok else 'HIBA – nézd át a fenti tételeket'}**")
    (out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "report.json").write_text(
        json.dumps({"ok": ok, "results": [dict(asdict(r), behaviour_ok=r.behaviour_ok) for r in results]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n".join(lines))
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Vizuális + viselkedési regressziós ellenőrzés.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--pages", nargs="+", default=["/"])
    parser.add_argument("--widths", nargs="+", type=int, default=[1440, 768, 390])
    parser.add_argument("--baseline-dir", default="visual-baseline")
    parser.add_argument("--out-dir", default="visual-report")
    parser.add_argument("--threshold", type=float, default=95.0)
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--no-link-check", action="store_true")
    args = parser.parse_args()
    if not args.base_url.startswith(("http://", "https://")):
        print("A --base-url http:// vagy https:// kezdetű legyen.")
        return 2
    baseline_dir, out_dir = Path(args.baseline_dir), Path(args.out_dir)
    baseline_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    results: List[PageResult] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(device_scale_factor=1, reduced_motion="reduce", locale="hu-HU", timezone_id="Europe/Budapest")
        for page_path in args.pages:
            for width in args.widths:
                name = f"{slug(page_path)}_{width}.png"
                current = out_dir / name
                r = capture(context, args.base_url, page_path, width, current, not args.no_link_check and width == args.widths[0])
                base = baseline_dir / name
                if args.update_baseline or not base.exists():
                    base.write_bytes(current.read_bytes())
                else:
                    diff = out_dir / f"{slug(page_path)}_{width}_diff.png"
                    r.score, r.layout, r.perceptual, r.size_mismatch = compare(base, current, diff)
                    r.diff_image = str(diff) if diff.exists() else None
                results.append(r)
        browser.close()
    return 0 if write_report(results, args, out_dir) else 1


if __name__ == "__main__":
    sys.exit(main())
