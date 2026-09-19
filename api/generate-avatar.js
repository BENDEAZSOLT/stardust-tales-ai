// Deprecated cost-bearing endpoint.
//
// The current Stardust Tales client does not call /api/generate-avatar.
// Character portraits are generated on-device, while paid page illustrations
// use /api/generate-illustration with verified store entitlement.
//
// Keep this route fail-closed so an unused public endpoint cannot consume the
// server's Gemini quota/API key. If a future client needs server-side avatar
// generation, reintroduce it together with authenticated entitlement checks
// and explicit rate limits.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(410).json({ error: 'Avatar generation endpoint is disabled.' });
}
