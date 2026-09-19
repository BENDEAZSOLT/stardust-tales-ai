import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('OK:', message);
  }
};

const story = read('api/generate-story.js');
const illustration = read('api/generate-illustration.js');
const tts = read('api/generate-tts.js');
const avatar = read('api/generate-avatar.js');
const quota = read('api/story-quota.js');
const verifyPurchase = read('api/verify-purchase.js');
const readiness = read('api/readiness.js');
const index = read('index.html');
const demo = read('assets/demo/index.html');

assert(!story.includes("Access-Control-Allow-Origin', '*'"), 'story API has no wildcard CORS');
assert(!illustration.includes("Access-Control-Allow-Origin', '*'"), 'illustration API has no wildcard CORS');
assert(!tts.includes("Access-Control-Allow-Origin', '*'"), 'TTS API has no wildcard CORS');
assert(!verifyPurchase.includes("Access-Control-Allow-Origin', '*'"), 'purchase verification API has no wildcard CORS');
assert(verifyPurchase.includes('function allowedOrigins()'), 'purchase verification uses origin allowlisting');
assert(verifyPurchase.includes("rawLength > 65_536"), 'purchase verification limits request size');
assert(verifyPurchase.includes('encodeURIComponent(purchaseToken)'), 'purchase token is URL encoded');
assert(readiness.includes("status: ready ? 'ready' : 'not_ready'"), 'readiness endpoint reports deployment state');
assert(!readiness.includes('process.env)') && !readiness.includes('...process.env'), 'readiness endpoint does not serialize the environment');

assert(!/req\.body[^\n]*system|\{\s*system\s*,\s*prompt[^\n]*\}\s*=\s*req\.body/.test(story),
  'story API does not accept client-supplied system/prompt');
assert(story.includes('function buildPrompts('), 'story prompts are built server-side');
assert(story.includes('parseStoryInput('), 'story inputs are validated');
assert(story.includes('reserveStoryQuota('), 'story generation reserves server-side quota');

assert(illustration.includes('verifyPaidPlan('), 'illustration requires verified paid entitlement');
assert(tts.includes('verifyPaidPlan('), 'cloud narration requires verified paid entitlement');
assert(avatar.includes("res.status(410)"), 'unused avatar endpoint is disabled');
assert(quota.includes('export async function verifyPaidPlan'), 'paid entitlement verifier is exported');

for (const [name, html] of [['index.html', index], ['assets/demo/index.html', demo]]) {
  assert(html.includes('getServerQuotaIdentity'), name + ' resolves server quota identity');
  assert(html.includes('purchaseToken'), name + ' sends purchase token for paid features');
  assert(html.includes('promptLang: t.promptLang'), name + ' sends structured story language');
  assert(!html.includes('body: JSON.stringify({ system: systemPrompt, prompt: userPrompt, maxTokens })'),
    name + ' does not send arbitrary prompts to production backend');
}

if (process.exitCode) process.exit(process.exitCode);
console.log('Security smoke checks passed.');
