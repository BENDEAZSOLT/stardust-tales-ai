// Vercel serverless function: /api/generate-story
// The app (web or native) calls THIS endpoint instead of api.anthropic.com
// directly. This function holds the real Anthropic API key server-side
// (as a Vercel environment variable) and forwards the request.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

const { system, prompt, maxTokens } = req.body || {};
  if (!system || !prompt) { res.status(400).json({ error: 'Missing system or prompt' }); return; }

if (!process.env.ANTHROPIC_API_KEY) {
  res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY - set it in your Vercel project settings.' });
  return;
}

try {
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens || 1500,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await anthropicRes.json();
  if (!anthropicRes.ok) {
    res.status(anthropicRes.status).json({ error: data.error?.message || 'Anthropic API error', details: data });
    return;
  }
  res.status(200).json(data);
} catch (e) {
  res.status(500).json({ error: e.message });
}
}
