import { reserveStoryQuota, releaseStoryQuota } from './story-quota.js';

// Vercel serverless function: /api/generate-story
// Accepts only structured story inputs. Prompt construction stays server-side
// so this endpoint cannot be used as a general-purpose proxy for our AI key.

const DEFAULT_ORIGINS = new Set(['https://stardust-tales-ai.vercel.app']);
const ALLOWED_LANGUAGES = new Set([
  'English', 'Hungarian', 'Spanish', 'German', 'French', 'Italian', 'Portuguese'
]);
const MOTIFS = 'forest|sky|ocean|castle|home|star|friend|animal|car|garden|dino|hero|fairy|blocks|space|mystery|robot|pirate|race|mission|legend|rescue|trophy|wand|music|arena';

function allowedOrigins() {
  const configured = String(process.env.STARDUST_ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...configured]);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed = allowedOrigins();
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return !origin || allowed.has(origin);
}

function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function parseStoryInput(body) {
  const name = cleanString(body.name, 40);
  const color = cleanString(body.color, 40);
  const worldLabel = cleanString(body.worldLabel, 100);
  const themeLabel = cleanString(body.themeLabel, 100);
  const readingLevel = cleanString(body.readingLevel, 120);
  const promptLang = cleanString(body.promptLang, 24);
  const age = Number(body.age);
  const pageCount = Number(body.pageCount);

  if (!name || !color || !worldLabel || !themeLabel || !readingLevel) {
    throw new Error('Missing required story fields.');
  }
  if (!Number.isInteger(age) || age < 2 || age > 14) {
    throw new Error('Invalid child age.');
  }
  if (!Number.isInteger(pageCount) || pageCount < 4 || pageCount > 12) {
    throw new Error('Invalid page count.');
  }
  if (!ALLOWED_LANGUAGES.has(promptLang)) {
    throw new Error('Unsupported story language.');
  }

  return { name, color, worldLabel, themeLabel, readingLevel, promptLang, age, pageCount };
}

function buildPrompts(input) {
  const { name, color, worldLabel, themeLabel, readingLevel, promptLang, age, pageCount } = input;
  const system = `You are a children's book author. Return ONLY a JSON object, nothing else — no explanation, no markdown code fence.
The JSON must look exactly like this:
{"title": "story title", "pages": [{"text": "1 short paragraph", "motif": "${MOTIFS}", "scene": "short visual description in ENGLISH of this exact page's setting and action"}]}
Return an array of exactly ${pageCount} "pages". Reading level: ${readingLevel}. Write "text" in ${promptLang}. The story must be coherent across all ${pageCount} pages: a beginning, a middle with an age-appropriate challenge, and an end with a gentle resolution. For "motif", always choose the keyword that best matches that page's main visual scene. For "scene", always write in ENGLISH regardless of the story language: a short, concrete, purely visual phrase (6-14 words) describing the specific location and physical action. Never include dialogue or quoted text in "scene". The story has no other named recurring character besides ${name}; ${name} carries the adventure without a named sidekick.`;

  const prompt = `Write a ${pageCount}-page personalized bedtime/adventure story appropriate for a ${age}-year-old.
Main character: ${name}, age ${age}.
Favorite color: ${color}.
World / setting genre: ${worldLabel}.
Underlying theme: ${themeLabel}.
The tone must be safe and age-appropriate, ending with ${name} feeling confident and happy. Write the whole response in ${promptLang}.`;

  return { system, prompt, maxTokens: Math.min(4000, 250 * pageCount + 300) };
}

export default async function handler(req, res) {
  const originAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(originAllowed ? 204 : 403).end();
    return;
  }
  if (!originAllowed) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawLength = Number(req.headers['content-length'] || 0);
  if (rawLength > 16_384) {
    res.status(413).json({ error: 'Request body too large.' });
    return;
  }

  let storyInput;
  try {
    storyInput = parseStoryInput(req.body || {});
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const { planId, purchaseToken, installId } = req.body || {};
  let quotaReservation = null;
  try {
    quotaReservation = await reserveStoryQuota({
      planId: planId || 'free',
      purchaseToken: purchaseToken || '',
      installId: installId || ''
    });
    if (!quotaReservation.allowed) {
      res.status(429).json({
        error: 'Story quota exhausted for this period.',
        quota: quotaReservation
      });
      return;
    }
  } catch (e) {
    const status = e.code === 'INVALID_ENTITLEMENT' ? 403 : 503;
    res.status(status).json({ error: e.message });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    try { await releaseStoryQuota(quotaReservation && quotaReservation.key); } catch (_) {}
    res.status(500).json({ error: 'Story service is not configured.' });
    return;
  }

  const { system, prompt, maxTokens } = buildPrompts(storyInput);

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
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      await releaseStoryQuota(quotaReservation && quotaReservation.key);
      res.status(anthropicRes.status).json({
        error: data.error?.message || 'Story generation failed.'
      });
      return;
    }

    res.status(200).json({ ...data, quota: quotaReservation });
  } catch (e) {
    try { await releaseStoryQuota(quotaReservation && quotaReservation.key); } catch (_) {}
    res.status(500).json({ error: 'Story generation failed.' });
  }
}
