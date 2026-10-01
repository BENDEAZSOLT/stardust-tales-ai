// Non-secret deployment readiness probe.
// Reports only whether required environment variables exist; it never returns
// credential values. Useful for CI/release checks after a Vercel deployment.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const quotaStoreConfigured = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  );

  const required = {
    storyModel: Boolean(process.env.ANTHROPIC_API_KEY),
    googlePlayEntitlement: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    quotaStore: quotaStoreConfigured
  };

  const optional = {
    aiIllustration: Boolean(process.env.FAL_KEY),
    cloudNarration: Boolean(process.env.GOOGLE_TTS_API_KEY),
    customAllowedOrigins: Boolean(process.env.STARDUST_ALLOWED_ORIGINS)
  };

  const ready = Object.values(required).every(Boolean);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    required,
    optional
  });
}
