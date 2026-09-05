// Vercel serverless function: /api/generate-illustration
// PAID-TIER ONLY (enforced client-side in index.html: free plan never calls
// this — it uses the zero-cost Canvas composite instead). Holds the real
// fal.ai API key server-side and calls FLUX.1 Kontext [pro], which edits the
// child's own reference photo into a themed storybook scene for that page
// while preserving the child's actual face/likeness.
//
// SETUP REQUIRED (you, not me — it's a secret credential):
//   1. Create a fal.ai account at https://fal.ai and an API key under
//      Dashboard -> Keys.
//   2. In Vercel (stardust-tales-ai project) -> Settings -> Environment
//      Variables, add FAL_KEY with that value.
//   3. Redeploy. Until FAL_KEY is set, this endpoint returns 500 and the
//      client silently falls back to the free Canvas composite — nothing
//      breaks either way.

const MOTIF_SCENE_HINTS = {
  forest: 'a magical, sunlit forest with tall trees',
  sky: 'a bright sky with fluffy clouds',
  ocean: 'a colorful underwater ocean scene',
  castle: 'a fairytale castle',
  home: 'a warm, cozy home interior',
  star: 'a dreamy starlit night sky',
  friend: 'a scene with a friendly companion character',
  animal: 'a scene with cute friendly animals',
  car: 'a fun scene with a colorful car or vehicle',
  garden: 'a blooming, colorful garden',
  dino: 'a prehistoric land with friendly dinosaurs',
  hero: 'a heroic adventure scene',
  fairy: 'a whimsical fairy-tale scene with sparkles',
  blocks: 'a playful scene with big colorful building blocks',
  space: 'outer space with planets and stars',
  mystery: 'a mysterious, curious scene full of wonder',
  robot: 'a fun scene with friendly cartoon robots',
  pirate: 'a pirate-ship adventure on the high seas',
  race: 'an exciting race track scene',
  mission: 'an exciting secret-mission scene',
  legend: 'an epic legendary-quest scene',
  rescue: 'a heartwarming rescue scene',
  trophy: 'a triumphant celebration scene with a trophy',
  wand: 'a magical scene with sparkles and a magic wand',
  music: 'a joyful scene full of music and instruments',
  arena: 'an exciting arena/competition scene'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { childPhotoDataUrl, pageText, motif } = req.body || {};
  if (!childPhotoDataUrl) { res.status(400).json({ error: 'Missing childPhotoDataUrl' }); return; }

  if (!process.env.FAL_KEY) {
    res.status(500).json({ error: 'Server is missing FAL_KEY - set it in your Vercel project settings.' });
    return;
  }

  const sceneHint = MOTIF_SCENE_HINTS[motif] || 'a warm, magical storybook scene';
  const storyBit = (pageText || '').slice(0, 400);
  const prompt = `Turn this photo into a warm, colorful children's storybook illustration in a soft cartoon/watercolor style. Keep the child's real face, hairstyle and recognizable features clearly intact - they are the main character. Place them inside ${sceneHint}, illustrating this moment from their story: "${storyBit}". Friendly, age-appropriate, no scary elements, no text or letters anywhere in the image.`;

  try {
    const falRes = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.FAL_KEY}`
      },
      body: JSON.stringify({
        prompt,
        image_url: childPhotoDataUrl,
        output_format: 'jpeg',
        safety_tolerance: '2'
      })
    });

    const data = await falRes.json();
    if (!falRes.ok) {
      res.status(falRes.status).json({ error: data.error || data.detail || 'fal.ai API error', details: data });
      return;
    }

    const imageUrl = data.images && data.images[0] && data.images[0].url;
    if (!imageUrl) { res.status(502).json({ error: 'fal.ai response had no image URL', details: data }); return; }

    res.status(200).json({ imageUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
