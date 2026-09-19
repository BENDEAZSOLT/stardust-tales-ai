import { verifyPaidPlan } from './story-quota.js';

// Vercel serverless function: /api/generate-tts
// Reads a story page aloud using Google Cloud Text-to-Speech (Neural2/Wavenet
// voices), which sounds far more natural than the device's built-in
// speechSynthesis engine (especially on Android, where the default voice is
// robotic and largely ignores rate/pitch tuning). Google Cloud gives a
// generous free tier for this - see the setup notes below - so normal app
// volume should stay at $0.
//
// SETUP REQUIRED (you, not me - it's a secret credential):
//   1. In Google Cloud Console (console.cloud.google.com), pick the project
//      tied to your billing account, then Enable APIs -> search
//      "Cloud Text-to-Speech API" -> Enable.
//   2. APIs & Services -> Credentials -> Create Credentials -> API key.
//      (You can reuse an existing unrestricted key, but a dedicated one is
//      safer - restrict it to "Cloud Text-to-Speech API" only.)
//   3. In Vercel (stardust-tales-ai project) -> Settings -> Environment
//      Variables, add GOOGLE_TTS_API_KEY with that value. Redeploy.
//   4. Until it's set, this endpoint returns 500 and the client silently
//      falls back to the device's built-in reader - nothing breaks either
//      way, it just sounds worse.
//
// COST: Google Cloud TTS free tier (per month, resets monthly, separate from
// any other API's quota): 1,000,000 characters free for Neural2/Wavenet
// voices, then ~$16 per additional 1M characters. A single story page is
// roughly 250-400 characters, so the free tier alone covers tens of
// thousands of page-reads per month.

// One natural, warm-sounding Neural2/Wavenet voice per supported language.
// (Hungarian and Portuguese have no Neural2 voices yet from Google, so they
// use the next tier down, Wavenet, which is still dramatically better than
// a device's default compact voice.)
const VOICE_MAP = {
  'en-US': { languageCode: 'en-US', name: 'en-US-Neural2-F' },
  'hu-HU': { languageCode: 'hu-HU', name: 'hu-HU-Wavenet-A' },
  'es-ES': { languageCode: 'es-ES', name: 'es-ES-Neural2-A' },
  'de-DE': { languageCode: 'de-DE', name: 'de-DE-Neural2-F' },
  'fr-FR': { languageCode: 'fr-FR', name: 'fr-FR-Neural2-C' },
  'it-IT': { languageCode: 'it-IT', name: 'it-IT-Neural2-A' },
  'pt-PT': { languageCode: 'pt-PT', name: 'pt-PT-Wavenet-D' }
};

export default async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  const configuredOrigins = String(process.env.STARDUST_ALLOWED_ORIGINS || '')
    .split(',').map(v => v.trim()).filter(Boolean);
  const allowedOrigins = new Set(['https://stardust-tales-ai.vercel.app', ...configuredOrigins]);
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(!origin || allowedOrigins.has(origin) ? 204 : 403).end(); return; }
  if (origin && !allowedOrigins.has(origin)) { res.status(403).json({ error: 'Origin not allowed.' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const rawLength = Number(req.headers['content-length'] || 0);
  if (rawLength > 65_536) {
    res.status(413).json({ error: 'Request body too large.' });
    return;
  }

  const { text, ttsTag, planId, purchaseToken } = req.body || {};
  if (!text) { res.status(400).json({ error: 'Missing text' }); return; }
  if (String(text).length > 3000) { res.status(413).json({ error: 'Text is too long.' }); return; }
  if (!Object.prototype.hasOwnProperty.call(VOICE_MAP, ttsTag)) {
    res.status(400).json({ error: 'Unsupported voice/language.' });
    return;
  }

  const entitled = await verifyPaidPlan(planId, purchaseToken).catch(() => false);
  if (!entitled) {
    res.status(403).json({ error: 'Paid narration entitlement could not be verified.' });
    return;
  }

  if (!process.env.GOOGLE_TTS_API_KEY) {
    res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY - set it in your Vercel project settings.' });
    return;
  }

  const voice = VOICE_MAP[ttsTag];
  // Text-to-Speech has a hard 5000-byte input limit per request; a single
  // story page is always far under that, but truncate defensively so a
  // malformed request can't 400 instead of just reading a shorter clip.
  const clippedText = String(text).slice(0, 3000);

  try {
    const ttsRes = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: clippedText },
          voice,
          // Slightly slower than 1.0 and a touch warmer in pitch - tuned for
          // a calm bedtime-story read rather than a brisk assistant voice.
          audioConfig: { audioEncoding: 'MP3', speakingRate: 0.92, pitch: -1.0 }
        })
      }
    );

    const data = await ttsRes.json();
    if (!ttsRes.ok) {
      res.status(ttsRes.status).json({ error: data.error?.message || 'Cloud Text-to-Speech API error' });
      return;
    }

    if (!data.audioContent) { res.status(502).json({ error: 'Cloud Text-to-Speech returned no audio' }); return; }

    res.status(200).json({ audioContent: data.audioContent }); // base64 MP3
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
