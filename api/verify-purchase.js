// Vercel serverless function: /api/verify-purchase
//
// Called by purchase-bridge.js right after the Digital Goods API /
// Payment Request API purchase flow completes in the Android TWA app.
// Verifies the purchase token against the Google Play Developer API
// (Android Publisher) and acknowledges it — required within 3 days of
// purchase or Google auto-refunds it — before the client marks the
// purchase as successful.
//
// SETUP REQUIRED (you do this — it's a secret credential, not something
// I can enter for you): in Vercel → stardust-tales-ai project → Settings
// → Environment Variables, add GOOGLE_SERVICE_ACCOUNT_JSON containing the
// full, raw JSON content of the service-account key file you downloaded
// from Google Cloud (revenuecat@gen-lang-client-0954472558...). That
// account already has "Manage orders and subscriptions" access in
// Play Console → Users and permissions, which is exactly the scope this
// endpoint needs.

import crypto from 'crypto';

const PACKAGE_NAME = 'app.vercel.stardust_tales_ai.twa';

const SUBSCRIPTION_SKUS = new Set(['weekly_2stories', 'monthly_20stories']);
const PRODUCT_SKUS = new Set(['storybook_addon_onetime']);

const DEFAULT_ORIGINS = new Set(['https://stardust-tales-ai.vercel.app']);

function allowedOrigins() {
  const configured = String(process.env.STARDUST_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
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

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedToken = null; // { accessToken, expiresAt } — reused across warm invocations

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Server is missing GOOGLE_SERVICE_ACCOUNT_JSON - set it in your Vercel project settings.');
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
  if (!tokenRes.ok) throw new Error('Token exchange failed: ' + JSON.stringify(tokenData));

  cachedToken = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000
  };
  return cachedToken.accessToken;
}

export default async function handler(req, res) {
  const originAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(originAllowed ? 204 : 403).end();
    return;
  }
  if (!originAllowed) {
    res.status(403).json({ valid: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ valid: false, error: 'Method not allowed' });
    return;
  }

  const rawLength = Number(req.headers['content-length'] || 0);
  if (rawLength > 65_536) {
    res.status(413).json({ valid: false, error: 'Request body too large.' });
    return;
  }

  const { sku, purchaseToken } = req.body || {};
  if (!sku || !purchaseToken || String(purchaseToken).length > 4096) {
    res.status(400).json({ valid: false, error: 'Missing or invalid sku/purchaseToken' });
    return;
  }

  try {
    const accessToken = await getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    if (SUBSCRIPTION_SKUS.has(sku)) {
      const tokenPath = encodeURIComponent(purchaseToken);
      const lookupUrl =
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${tokenPath}`;
      const getRes = await fetch(lookupUrl, { headers: authHeader });
      const purchase = await getRes.json();
      if (!getRes.ok) {
        res.status(200).json({ valid: false, error: 'Subscription lookup failed.' });
        return;
      }

      const entitlementStates = new Set([
        'SUBSCRIPTION_STATE_ACTIVE',
        'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        'SUBSCRIPTION_STATE_CANCELED'
      ]);
      const now = Date.now();
      const active = entitlementStates.has(purchase.subscriptionState) &&
        Array.isArray(purchase.lineItems) &&
        purchase.lineItems.some(item => {
          if (item.productId !== sku || !item.expiryTime) return false;
          const expiry = Date.parse(item.expiryTime);
          return Number.isFinite(expiry) && expiry > now;
        });

      if (active && purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
        const acknowledgeUrl =
          `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${encodeURIComponent(sku)}/tokens/${tokenPath}:acknowledge`;
        const acknowledgeRes = await fetch(acknowledgeUrl, {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!acknowledgeRes.ok) {
          res.status(502).json({ valid: false, error: 'Subscription acknowledgement failed.' });
          return;
        }
      }
      res.status(200).json({ valid: !!active, entitlement: active ? sku : null });
      return;
    }

    if (PRODUCT_SKUS.has(sku)) {
      const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/products/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(purchaseToken)}`;
      const getRes = await fetch(base, { headers: authHeader });
      const purchase = await getRes.json();
      if (!getRes.ok) {
        res.status(200).json({ valid: false, error: 'Product lookup failed.' });
        return;
      }

      // purchaseState: 0 = purchased.
      const purchased = purchase.purchaseState === 0;
      if (purchased && purchase.acknowledgementState === 0) {
        const acknowledgeRes = await fetch(base + ':acknowledge', {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!acknowledgeRes.ok) {
          res.status(502).json({ valid: false, error: 'Product acknowledgement failed.' });
          return;
        }
      }
      res.status(200).json({ valid: !!purchased, entitlement: purchased ? sku : null });
      return;
    }

    res.status(400).json({ valid: false, error: 'Unknown sku: ' + sku });
  } catch (e) {
    console.error('Purchase verification failed:', e);
    res.status(500).json({ valid: false, error: 'Purchase verification failed.' });
  }
}
