// Vercel serverless function: /api/generate-avatar
// Turns the parent-uploaded photo of their child into a stylized,
// storybook-style cartoon character using Google's Gemini image model.
// Google AI Studio offers a free tier for this (no cost while usage stays
// within the free quota) - see https://aistudio.google.com/apikey
//
// Env var required in Vercel: GEMINI_API_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { source_image, age_band } = req.body || {};
  if (!source_image) { res.status(400).json({ error: 'Missing source_image' }); return; }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY - set it in your Vercel project settings (free key from https://aistudio.google.com/apikey).' });
    return;
  }

  // source_image arrives as a data URL: "data:image/jpeg;base64,....."
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(source_image);
  if (!match) { res.status(400).json({ error: 'source_image must be a base64 data URL' }); return; }
  const mimeType = match[1];
  const base64Data = match[2];

  const prompt = `Turn the person in this photo into a warm, friendly children's storybook cartoon character illustration, appropriate for a ${age_band || 'young child'} reader. Keep it recognizable but stylized: simple soft shapes, gentle colors, storybook art style, plain neutral background, head-and-shoulders portrait, no text, no watermark, family-friendly.`;

  try {
    const model = 'gemini-2.5-flash-image';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }]
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: data.error?.message || 'Gemini API error', details: data });
      return;
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData || p.inline_data);
    const inline = imagePart && (imagePart.inlineData || imagePart.inline_data);
    if (!inline) {
      res.status(502).json({ error: 'Gemini did not return an image', details: data });
      return;
    }

    const outMime = inline.mimeType || inline.mime_type || 'image/png';
    const outData = inline.data;
    res.status(200).json({ image_url: `data:${outMime};base64,${outData}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
