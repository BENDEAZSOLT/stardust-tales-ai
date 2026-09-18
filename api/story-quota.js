import crypto from 'crypto';

const PACKAGE_NAME = 'app.vercel.stardust_tales_ai.twa';
const PLAN_CONFIG = {
  free: { quota: 3, sku: null, period: 'lifetime', ttlSeconds: 0 },
  weekly: { quota: 2, sku: 'weekly_2stories', period: 'week', ttlSeconds: 10 * 24 * 60 * 60 },
  monthly: { quota: 20, sku: 'monthly_20stories', period: 'month', ttlSeconds: 40 * 24 * 60 * 60 }
};

let cachedToken = null;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.accessToken;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Server is missing GOOGLE_SERVICE_ACCOUNT_JSON.');
  const key = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const toSign = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(toSign).sign(key.private_key);
  const jwt = toSign + '.' + base64url(signature);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Google token exchange failed.');

  cachedToken = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000
  };
  return cachedToken.accessToken;
}

export async function verifyPaidPlan(planId, purchaseToken) {
  const config = PLAN_CONFIG[planId];
  if (!config || !config.sku || !purchaseToken) return false;

  const accessToken = await getGoogleAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${config.sku}/tokens/${encodeURIComponent(purchaseToken)}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const purchase = await response.json();
  if (!response.ok) return false;

  const paid = purchase.paymentState === 1 || purchase.paymentState === 2;
  const notExpired = Number(purchase.expiryTimeMillis || 0) > Date.now();
  return paid && notExpired;
}

function periodKey(period) {
  const now = new Date();
  if (period === 'month') {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (period === 'week') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return 'lifetime';
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Server quota store is not configured.');
  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand(command) {
  const { url, token } = redisConfig();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Quota store request failed.');
  return data.result;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export async function reserveStoryQuota({ planId, purchaseToken, installId }) {
  const requestedPlan = PLAN_CONFIG[planId] ? planId : 'free';
  let effectivePlan = requestedPlan;
  let identity;

  if (requestedPlan === 'free') {
    if (!installId || String(installId).length < 12 || String(installId).length > 200) {
      throw new Error('Missing or invalid installation identifier.');
    }
    identity = 'install:' + stableHash(installId);
  } else {
    const valid = await verifyPaidPlan(requestedPlan, purchaseToken);
    if (!valid) {
      const err = new Error('Paid plan entitlement could not be verified.');
      err.code = 'INVALID_ENTITLEMENT';
      throw err;
    }
    identity = 'purchase:' + stableHash(purchaseToken);
  }

  const config = PLAN_CONFIG[effectivePlan];
  const key = `quota:story:${effectivePlan}:${periodKey(config.period)}:${identity}`;
  const script =
    "local current=tonumber(redis.call('GET',KEYS[1]) or '0');" +
    "local limit=tonumber(ARGV[1]);" +
    "if current>=limit then return {0,current}; end;" +
    "local value=redis.call('INCR',KEYS[1]);" +
    "local ttl=tonumber(ARGV[2]);" +
    "if value==1 and ttl>0 then redis.call('EXPIRE',KEYS[1],ttl); end;" +
    "if value<=limit then return {1,value}; end;" +
    "return {0,value};";

  const result = await redisCommand(['EVAL', script, '1', key, String(config.quota), String(config.ttlSeconds)]);
  const allowed = Array.isArray(result) && Number(result[0]) === 1;
  const used = Array.isArray(result) ? Number(result[1]) : config.quota;

  return {
    allowed,
    key,
    plan: effectivePlan,
    quota: config.quota,
    used,
    remaining: Math.max(0, config.quota - used)
  };
}

export async function releaseStoryQuota(key) {
  if (!key) return;
  const script =
    "local current=tonumber(redis.call('GET',KEYS[1]) or '0');" +
    "if current<=0 then return 0; end;" +
    "return redis.call('DECR',KEYS[1]);";
  await redisCommand(['EVAL', script, '1', key]);
}
