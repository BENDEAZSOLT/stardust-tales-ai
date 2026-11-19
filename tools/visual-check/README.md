# Visual Check

Vizuális és viselkedési regressziós ellenőrzés az éles Stardust Tales oldalra.

## Mit ellenőriz
- Képernyőkép 1440 / 768 / 390 px-en, összevetve a `baseline/` képekkel. Pontszám = (16 px-es csempék egyezése + SSIM) × 50, küszöb 95%.
- Konzolhiba, JS kivétel, saját domainre menő 4xx/5xx kérés, törött saját link, mobilon vízszintes túlcsordulás.
- Gombokra nem kattint (éles oldalon vásárlást indíthatna).

## Mikor fut
- Minden sikeres **Production** Vercel deploy után (`deployment_status`).
- Naponta 05:17 UTC-kor.
- Kézzel: Actions → Visual Check → Run workflow.

## Beállítás
Alapértelmezés: `https://stardust-tales-ai.vercel.app`, oldalak: `/ /privacy.html /terms.html`.
Felülírható repository változókkal: `VISUAL_CHECK_URL`, `VISUAL_CHECK_PAGES`.

## Baseline
- Az első kézi vagy ütemezett futás elkészíti és commitolja a `baseline/` mappát.
- Szándékos dizájnváltozás után: Run workflow, `update_baseline` bepipálva.

## Helyi futtatás
```bash
pip install playwright numpy pillow && python -m playwright install chromium
python tools/visual-check/visual_check.py --base-url https://stardust-tales-ai.vercel.app --pages / /privacy.html /terms.html --baseline-dir tools/visual-check/baseline
```
Kimenet: `visual-report/report.md`, képernyőképek, `*_diff.png` eltéréstérképek.
