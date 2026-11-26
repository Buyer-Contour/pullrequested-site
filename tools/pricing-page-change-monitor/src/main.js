import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Actor, log } from 'apify';
import { Agent, fetch } from 'undici';
import { comparePricing, failedCheck, hashText, validateSnapshot } from './pricing.js';
import { fetchPublicHtml, isPublicAddress, PageError, PublicUrlError } from './public-page.js';
import { loadRunProgress, PAGE_CHECKED } from './run-progress.js';

if (process.env.APIFY_LOCAL_STORAGE_DIR && !process.env.CRAWLEE_STORAGE_DIR) {
  process.env.CRAWLEE_STORAGE_DIR = process.env.APIFY_LOCAL_STORAGE_DIR;
}

async function requestPinned({ url, host }, options) {
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicUrlError('The URL must resolve only to public addresses.');
  }
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, { all, family }, callback) {
        const eligible = family ? addresses.filter((record) => record.family === family) : addresses;
        if (!eligible.length) return callback(new Error('No eligible public address for this host.'));
        if (all) return callback(null, eligible);
        return callback(null, eligible[0].address, eligible[0].family);
      },
    },
  });
  try {
    const response = await fetch(url, { ...options, dispatcher });
    return { response, close: () => dispatcher.destroy() };
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}

await Actor.main(async () => {
  const { urls, previousSnapshots = {}, keywords = [] } = (await Actor.getInput()) ?? {};
  if (!Array.isArray(urls) || !urls.length || urls.length > 100 || urls.some((url) => typeof url !== 'string')) {
    throw new TypeError('Provide between 1 and 100 pricing page URLs.');
  }
  if (!Array.isArray(keywords) || keywords.length > 50 || keywords.some((term) => typeof term !== 'string')) {
    throw new TypeError('Provide up to 50 keywords as strings.');
  }
  if (!previousSnapshots || typeof previousSnapshots !== 'object' || Array.isArray(previousSnapshots)) {
    throw new TypeError('previousSnapshots must be an object keyed by URL.');
  }
  for (const snapshot of Object.values(previousSnapshots)) validateSnapshot(snapshot);
  const store = await Actor.openKeyValueStore('pricing-monitor-state');
  const pricing = Actor.getChargingManager().getPricingInfo();
  const shouldCharge = Actor.isAtHome() && pricing.isPayPerEvent;
  if (shouldCharge && !Object.hasOwn(pricing.perEventPrices, PAGE_CHECKED)) {
    throw new Error(`The ${PAGE_CHECKED} billable event must be configured for this Actor.`);
  }
  const progress = shouldCharge
    ? await loadRunProgress(await Actor.openKeyValueStore(), (options) => Actor.charge(options))
    : undefined;

  for (const url of new Set(urls)) {
    if (progress?.hasCharged(url)) continue;
    const key = await hashText(url);
    const previous = Object.hasOwn(previousSnapshots, url) ? previousSnapshots[url] : await store.getValue(key);
    let result;
    try {
      result = await comparePricing(url, await fetchPublicHtml(url, requestPinned), previous, keywords);
    } catch (error) {
      await Actor.pushData(failedCheck(url, error instanceof PageError ? error.message : 'Could not fetch or read the page.'));
      continue;
    }
    let chargeLimitReached = false;
    if (progress) {
      const { chargedCount, eventChargeLimitReached } = await progress.chargePage(url);
      if (!chargedCount) {
        log.info('Charge limit reached. No more URLs will be checked.');
        break;
      }
      chargeLimitReached = eventChargeLimitReached;
    }
    await Actor.pushData(result);
    await store.setValue(key, { contentHash: result.contentHash, pricingText: result.pricingText });
    if (chargeLimitReached) {
      log.info('Charge limit reached. No more URLs will be checked.');
      break;
    }
  }
});
