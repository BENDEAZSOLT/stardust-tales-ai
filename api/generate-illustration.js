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

  const { childPhotoDataUrl, pageText, motif, scene } = req.body || {};
  if (!childPhotoDataUrl) { res.status(400).json({ error: 'Missing childPhotoDataUrl' }); return; }

  if (!process.env.FAL_KEY) {
    res.status(500).json({ error: 'Server is missing FAL_KEY - set it in your Vercel project settings.' });
    return;
  }

  // FIX (2026-09-07): illustrations were coming back as random/generic
  // scenes (a field, a house) that didn't match what was actually happening
  // on that page — e.g. a page about investigating a museum with a
  // magnifying glass should show a museum with a magnifying glass, not a
  // generic backdrop. Root cause: this only ever had the ~25-keyword
  // MOTIF_SCENE_HINTS bucket to work with, which is too coarse to capture a
  // specific plot beat. The client (index.html) now also sends `scene`: a
  // short, concrete, English-only visual description of THIS exact page's
  // setting and action, written by the story-writing model itself (see the
  // systemPrompt's "scene" field). Use that as the primary descriptor and
  // only fall back to the generic motif hint for older/malformed requests
  // that don't include one.
  const sceneHint = MOTIF_SCENE_HINTS[motif] || 'a warm, magical storybook scene';
  const specificScene = (scene || '').trim().slice(0, 200);
  const effectiveScene = specificScene || sceneHint;
  const storyBit = (pageText || '').slice(0, 400);
  // FIX (2026-09-05): the previous prompt + default params produced an
  // edited close-up of the reference photo instead of a real storybook
  // scene, because FLUX.1 Kontext is an image-EDIT model that stays close
  // to the input photo's framing/composition unless pushed hard the other
  // way. Two changes fix this: (1) the prompt now explicitly forbids a
  // portrait/selfie/headshot crop and asks for a wide, full-body scene shot
  // from a distance, describing what the character is DOING; (2) a much
  // higher guidance_scale (how strongly the model follows the text prompt
  // vs. copying the input image) plus an explicit landscape aspect_ratio
  // that matches the app's illustration box, instead of inheriting the
  // reference photo's own (often portrait/selfie) aspect ratio.
  // FIX (2026-09-05, later same day): real generations were coming back with
  // garbled fake text/lettering baked into the picture (the model rendering
  // gibberish words when it decided this looked like a "book page"). Two
  // causes, both addressed: (1) the earlier prompt literally said "the way
  // an illustrated page in a picture book looks", which invites a page-with-
  // text composition; (2) quoting the raw story paragraph in the prompt
  // reads to the model like text it should render onto the image. Now the
  // story text is only paraphrased as a hint at a high level (not quoted),
  // the "book page" framing is gone in favor of plain "single illustration",
  // and the no-text instruction is repeated more forcefully and specifically
  // (signs, books, labels included) since one soft mention wasn't enough.
  // FIX (2026-09-05, later still): generations sometimes showed the child
  // from behind or in profile (e.g. running away from camera into the
  // scene), which reads oddly for a "starring in their own story" app.
  // Added an explicit forward-facing instruction, repeated at the end as a
  // hard constraint alongside the no-text rule, since a single mention
  // wasn't reliably followed either.
  const scenePrompt = specificScene
    ? `The character is ${effectiveScene}`
    : (storyBit ? `A moment where the character is: ${effectiveScene}, matching the mood and action of this part of their adventure` : `A moment where the character is ${effectiveScene}`);
  const prompt = `A single wordless children's book illustration, soft cartoon/watercolor style, full-body wide shot from a distance — NOT a portrait, NOT a headshot, NOT a close-up, NOT a selfie. Show the whole character small within a big, detailed environment, actively doing something, facing toward the viewer/camera with their face clearly visible. ${scenePrompt}. Keep the child's real face, hair and recognizable features so they're clearly the same person, but completely change the framing, pose and background. Friendly, age-appropriate, no scary elements. Absolutely no text, letters, numbers, words, writing, captions, speech bubbles, or symbols anywhere in the image — not on signs, books, clothing, objects, or the background. This is a pure picture with zero written content of any kind. The character must be facing forward or three-quarter view toward the viewer with their face clearly visible at all times — never shown from behind, never with their back turned, never facing away from the camera.`;

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
        safety_tolerance: '2',
        aspect_ratio: '3:2',
        guidance_scale: 9
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
