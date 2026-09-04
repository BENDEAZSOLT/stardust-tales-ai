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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ valid: false, error: 'Method not allowed' }); return; }

  const { sku, purchaseToken } = req.body || {};
  if (!sku || !purchaseToken) {
    res.status(400).json({ valid: false, error: 'Missing sku or purchaseToken' });
    return;
  }

  try {
    const accessToken = await getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    if (SUBSCRIPTION_SKUS.has(sku)) {
      const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${sku}/tokens/${purchaseToken}`;
      const getRes = await fetch(base, { headers: authHeader });
      const purchase = await getRes.json();
      if (!getRes.ok) {
        res.status(200).json({ valid: false, error: (purchase.error && purchase.error.message) || 'Lookup failed' });
        return;
      }

      // paymentState: 1 = payment received, 2 = free trial. Both count as active.
      const active = purchase.paymentState === 1 || purchase.paymentState === 2;
      if (purchase.acknowledgementState === 0) {
        await fetch(base + ':acknowledge', {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      }
      res.status(200).json({ valid: !!active, entitlement: sku });
      return;
    }

    if (PRODUCT_SKUS.has(sku)) {
      const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/products/${sku}/tokens/${purchaseToken}`;
      const getRes = await fetch(base, { headers: authHeader });
      const purchase = await getRes.json();
      if (!getRes.ok) {
        res.status(200).json({ valid: false, error: (purchase.error && purchase.error.message) || 'Lookup failed' });
        return;
      }

      // purchaseState: 0 = purchased.
      const purchased = purchase.purchaseState === 0;
      if (purchase.acknowledgementState === 0) {
        await fetch(base + ':acknowledge', {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      }
      res.status(200).json({ valid: !!purchased, entitlement: sku });
      return;
    }

    res.status(400).json({ valid: false, error: 'Unknown sku: ' + sku });
  } catch (e) {
    res.status(500).json({ valid: false, error: e.message });
  }
}
