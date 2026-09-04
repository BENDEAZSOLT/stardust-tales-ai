// NATIVE PURCHASE BRIDGE — Google Play Billing via the Digital Goods API +
// Payment Request API.
//
// IMPORTANT ARCHITECTURE NOTE (fixed 2026-09-03): this file previously
// assumed a Capacitor native shell with the @revenuecat/purchases-capacitor
// plugin. That does NOT exist in this project — the Android app is packaged
// as a TWA (Trusted Web Activity: a thin Chrome wrapper around this same
// PWA, no native code, no Capacitor bridge). A TWA can only take payments
// through the browser's Digital Goods API + Payment Request API, which is
// what this file now implements. RevenueCat is not used for the Android
// purchase flow — the RevenueCat Play Store app connection you already set
// up is fine to keep around (harmless), but it is not what actually
// processes these purchases; the code below talks to Google Play directly
// and verifies/acknowledges purchases through /api/verify-purchase.js.
//
// This only works: on Android, inside the installed TWA app (or Chrome
// 101+ visiting a site that's Play-Store-verified via Digital Asset
// Links), over HTTPS. On iOS, desktop, or a browser tab that isn't the
// installed TWA, none of this is available and every function below
// safely returns false — the app's existing demo-alert fallback in
// index.html still runs, nothing breaks.
//
// SETUP STILL REQUIRED — you (not me, it's a secret credential):
//   In your Vercel project (stardust-tales-ai) → Settings → Environment
//   Variables, add GOOGLE_SERVICE_ACCOUNT_JSON containing the full, raw
//   JSON content of the service-account key file you already downloaded
//   from Google Cloud (revenuecat@gen-lang-client-0954472558...). It's the
//   same account that already has "Manage orders and subscriptions" access
//   in Play Console → Users and permissions — /api/verify-purchase.js uses
//   it to verify and acknowledge purchases server-side.

const PLAN_SKUS = {
  weekly: "weekly_2stories",
  monthly: "monthly_20stories"
};
const STORYBOOK_ADDON_SKU = "storybook_addon_onetime";

let _serviceInstance = null;
let _serviceChecked = false;

async function getDigitalGoodsService() {
  if (_serviceChecked) return _serviceInstance;
  _serviceChecked = true;
  if (!("getDigitalGoodsService" in window)) return null;
  try {
    _serviceInstance = await window.getDigitalGoodsService("https://play.google.com/billing");
  } catch (e) {
    console.warn("Digital Goods Service unavailable:", e);
    _serviceInstance = null;
  }
  return _serviceInstance;
}

// Runs the full Payment Request flow for one SKU, then verifies +
// acknowledges the purchase on our own backend (required within 3 days or
// Google auto-refunds it). Returns { ok, reason?, entitlement? }.
async function buySku(sku) {
  const service = await getDigitalGoodsService();
  if (!service) return { ok: false, reason: "unsupported" };

  const paymentMethods = [{ supportedMethods: "https://play.google.com/billing", data: { sku } }];
  // total.amount is required by the Payment Request API but ignored by Play
  // Billing — the real price comes from what you configured for this SKU
  // in Play Console.
  const paymentDetails = { total: { label: "Total", amount: { currency: "USD", value: "0" } } };

  let response;
  try {
    const request = new PaymentRequest(paymentMethods, paymentDetails);
    response = await request.show();
  } catch (e) {
    return { ok: false, reason: "cancelled" };
  }

  const purchaseToken = response.details && response.details.purchaseToken;
  if (!purchaseToken) {
    try { await response.complete("fail"); } catch (_) {}
    return { ok: false, reason: "no_purchase_token" };
  }

  try {
    const verifyRes = await fetch("/api/verify-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, purchaseToken })
    });
    const verify = await verifyRes.json();
    if (verify && verify.valid) {
      await response.complete("success");
      return { ok: true, entitlement: verify.entitlement };
    }
    await response.complete("fail");
    return { ok: false, reason: "verification_failed" };
  } catch (e) {
    console.error("Purchase verification failed:", e);
    try { await response.complete("fail"); } catch (_) {}
    return { ok: false, reason: "network_error" };
  }
}

window.NativePurchase = {
  // Legacy single-story purchase hook, kept so index.html's call site
  // doesn't throw — but no such product was ever created in Play Console
  // (only the 2 subscriptions + storybook add-on from the spec exist), so
  // this intentionally always falls back to the demo alert until/unless
  // you decide to actually ship a per-story SKU.
  async purchaseStory(_storyId, _price) {
    return false;
  },

  planPackageIds: PLAN_SKUS,

  async purchasePlan(planId, _price) {
    const sku = PLAN_SKUS[planId];
    if (!sku) return false;
    const result = await buySku(sku);
    if (!result.ok && result.reason && result.reason !== "cancelled") {
      console.warn("Plan purchase failed:", planId, result.reason);
    }
    return result.ok;
  },

  storybookAddonProductId: STORYBOOK_ADDON_SKU,

  async purchaseStorybookAddon(_price) {
    const result = await buySku(STORYBOOK_ADDON_SKU);
    if (!result.ok && result.reason && result.reason !== "cancelled") {
      console.warn("Storybook add-on purchase failed:", result.reason);
    }
    return result.ok;
  },

  // Call on app startup to restore the user's actual active plan instead
  // of defaulting to 'free' every launch.
  async getActivePlan() {
    const service = await getDigitalGoodsService();
    if (!service) return "free";
    try {
      const purchases = await service.listPurchases();
      const owned = new Set(purchases.map(p => p.itemId));
      if (owned.has(PLAN_SKUS.monthly)) return "monthly";
      if (owned.has(PLAN_SKUS.weekly)) return "weekly";
      return "free";
    } catch (e) {
      console.error("Could not list purchases:", e);
      return "free";
    }
  },

  // Not tied to a plan tier — check separately wherever the storybook
  // compile feature is gated.
  async hasStorybookAddon() {
    const service = await getDigitalGoodsService();
    if (!service) return false;
    try {
      const purchases = await service.listPurchases();
      return purchases.some(p => p.itemId === STORYBOOK_ADDON_SKU);
    } catch (e) {
      console.error("Could not list purchases:", e);
      return false;
    }
  }
};

// Restore whatever the user already owns as soon as the page loads, instead
// of defaulting to 'free' every launch. No-ops harmlessly outside the
// installed Android app (getDigitalGoodsService is undefined there, so both
// calls below resolve to 'free' / false immediately). Depends on
// currentPlan, hasStorybookAddon, renderPlans() and updateQuotaUI() from
// index.html's inline script, which runs before this file loads.
(async function restoreEntitlementsOnLoad() {
  try {
    const [plan, addon] = await Promise.all([
      window.NativePurchase.getActivePlan(),
      window.NativePurchase.hasStorybookAddon()
    ]);
    if (typeof currentPlan !== "undefined" && plan && plan !== "free") {
      currentPlan = plan;
    }
    if (typeof hasStorybookAddon !== "undefined" && addon) {
      hasStorybookAddon = true;
    }
    if (typeof renderPlans === "function") renderPlans();
    if (typeof updateQuotaUI === "function") updateQuotaUI();
  } catch (e) {
    console.error("Could not restore entitlements on load:", e);
  }
})();
