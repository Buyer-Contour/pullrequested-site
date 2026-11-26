import { hashText } from './pricing.js';

export const PAGE_CHECKED = 'page-checked';
const RUN_PROGRESS = 'RUN_PROGRESS';

export async function loadRunProgress(store, charge) {
  const chargedUrls = new Set(await store.getValue(RUN_PROGRESS) ?? []);
  return {
    hasCharged: (url) => chargedUrls.has(url),
    async chargePage(url) {
      const idempotencyKey = await hashText(url);
      const result = await charge({ eventName: PAGE_CHECKED, idempotencyKey });
      if (result.chargedCount) {
        chargedUrls.add(url);
        await store.setValue(RUN_PROGRESS, [...chargedUrls]);
      }
      return result;
    },
  };
}
