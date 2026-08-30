// Bridges window.NativePurchase.purchaseStory() (called from the app UI)
// to the RevenueCat plugin, which is already installed in this project
// (@revenuecat/purchases-capacitor) and wraps both App Store and
// Google Play billing behind one API.
//
// TO ACTIVATE — you'll need to do this yourself, since it requires
// logging into accounts I can't access:
//   1. Create a free RevenueCat account: https://app.revenuecat.com/signup
//   2. In RevenueCat, connect your App Store Connect and Google Play
//      Console apps (both need their own developer accounts —
//      Apple Developer Program $99/yr, Google Play Console $25 one-time).
//   3. Create a product ("story_purchase", one-time, $6.99) in both
//      App Store Connect and Play Console, then attach it to a RevenueCat
//      Offering.
//   4. Copy your RevenueCat public SDK key (Project settings > API keys)
//      into REVENUECAT_API_KEY below.
//
// Until you do that, purchaseStory() safely returns false and the app
// falls back to the in-browser demo alert — nothing breaks.

const REVENUECAT_API_KEY = ""; // paste your RevenueCat public API key here

function getPurchasesPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases;
}

window.NativePurchase = {
  async purchaseStory(storyId, price) {
    const Purchases = getPurchasesPlugin();
    if (!Purchases || !REVENUECAT_API_KEY) return false;

    try {
      await Purchases.configure({ apiKey: REVENUECAT_API_KEY });
      const offerings = await Purchases.getOfferings();
      const pkg = offerings && offerings.current && offerings.current.availablePackages
        ? offerings.current.availablePackages[0]
        : null;
      if (!pkg) {
        console.warn("No RevenueCat offering package found — check your dashboard setup.");
        return false;
      }
      const result = await Purchases.purchasePackage({ aPackage: pkg });
      return !!(result && result.customerInfo);
    } catch (e) {
      console.error("Purchase failed:", e);
      return false;
    }
  },

  // Maps each recurring app plan (free/weekly/monthly) to a RevenueCat
  // package identifier. Create matching products in App Store Connect /
  // Play Console, attach them to a RevenueCat Offering, and set the
  // identifiers below to whatever you named them there. The storybook
  // compilation is a separate ONE-TIME purchase — see
  // storybookAddonProductId further down, not part of this map.
  planPackageIds: {
    weekly: "weekly_2stories",
    monthly: "monthly_20stories"
  },

  async purchasePlan(planId, price) {
    const Purchases = getPurchasesPlugin();
    if (!Purchases || !REVENUECAT_API_KEY) return false;
    const packageId = this.planPackageIds[planId];
    if (!packageId) return false;

    try {
      await Purchases.configure({ apiKey: REVENUECAT_API_KEY });
      const offerings = await Purchases.getOfferings();
      const pkg = offerings && offerings.current && offerings.current.availablePackages
        ? offerings.current.availablePackages.find(p => p.identifier === packageId)
        : null;
      if (!pkg) {
        console.warn("No RevenueCat package found for plan:", planId, "— check your Offering setup.");
        return false;
      }
      const result = await Purchases.purchasePackage({ aPackage: pkg });
      return !!(result && result.customerInfo);
    } catch (e) {
      console.error("Plan purchase failed:", e);
      return false;
    }
  },

  // One-time storybook compilation purchase (not a subscription package).
  storybookAddonProductId: "storybook_addon_onetime",

  async purchaseStorybookAddon(price) {
    const Purchases = getPurchasesPlugin();
    if (!Purchases || !REVENUECAT_API_KEY) return false;
    try {
      await Purchases.configure({ apiKey: REVENUECAT_API_KEY });
      const offerings = await Purchases.getOfferings();
      const pkg = offerings && offerings.current && offerings.current.availablePackages
        ? offerings.current.availablePackages.find(p => p.identifier === this.storybookAddonProductId)
        : null;
      if (!pkg) {
        console.warn("No RevenueCat package found for the storybook add-on — check your Offering setup.");
        return false;
      }
      const result = await Purchases.purchasePackage({ aPackage: pkg });
      return !!(result && result.customerInfo);
    } catch (e) {
      console.error("Storybook add-on purchase failed:", e);
      return false;
    }
  },

  // Call this on app startup to restore the user's actual active plan
  // from RevenueCat instead of defaulting to 'free' every launch. Wire
  // this into your own app-init code once entitlements are configured.
  async getActivePlan() {
    const Purchases = getPurchasesPlugin();
    if (!Purchases || !REVENUECAT_API_KEY) return "free";
    try {
      await Purchases.configure({ apiKey: REVENUECAT_API_KEY });
      const { customerInfo } = await Purchases.getCustomerInfo();
      const active = customerInfo && customerInfo.entitlements ? customerInfo.entitlements.active : {};
      if (active["max"]) return "max";
      if (active["monthly"]) return "monthly";
      if (active["weekly"]) return "weekly";
      return "free";
    } catch (e) {
      console.error("Could not fetch active plan:", e);
      return "free";
    }
  }
};
