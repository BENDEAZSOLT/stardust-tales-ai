import fs from 'node:fs';

const read = p => fs.readFileSync(p, 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('OK:', message);
  }
};

const quota = read('api/story-quota.js');
const story = read('api/generate-story.js');
const bridge = read('purchase-bridge.js');
const index = read('index.html');

assert(quota.includes('/purchases/subscriptionsv2/tokens/'), 'uses Google Play subscriptionsv2');
assert(!quota.includes('/purchases/subscriptions/' + '${config.sku}' + '/tokens/'), 'does not use deprecated subscriptions.get');
assert(quota.includes('SUBSCRIPTION_STATE_ACTIVE'), 'active subscription state is allowed');
assert(quota.includes('SUBSCRIPTION_STATE_IN_GRACE_PERIOD'), 'grace-period state retains entitlement');
assert(quota.includes('SUBSCRIPTION_STATE_CANCELED'), 'canceled-but-unexpired state can retain entitlement');
assert(quota.includes("item.productId !== config.sku"), 'verified line item must match requested plan SKU');
assert(quota.includes('Date.parse(item.expiryTime)'), 'line-item expiry is checked');
assert(quota.includes("['EVAL', script, '1', key"), 'quota reservation uses atomic Redis Lua');
assert(story.includes('reserveStoryQuota('), 'story generation reserves quota before AI call');
assert(story.includes('releaseStoryQuota('), 'failed story generation releases reservation');
assert(bridge.includes('getStoryEntitlement'), 'purchase bridge exposes active plan token');
assert(index.includes('getServerQuotaIdentity'), 'client sends quota identity to server');

if (process.exitCode) process.exit(process.exitCode);
console.log('Quota smoke checks passed.');
