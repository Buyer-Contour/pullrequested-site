import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRunProgress } from '../src/run-progress.js';

test('reloads charged URLs and uses a stable idempotency key if a charge has to be retried', async () => {
  const values = new Map();
  let saveFails = true;
  const store = {
    getValue: (key) => values.get(key),
    setValue(key, value) {
      if (saveFails) throw new Error('Could not save progress');
      values.set(key, value);
    },
  };
  const requests = [];
  const charge = (options) => {
    requests.push(options);
    return { chargedCount: 1 };
  };
  const url = 'https://example.com/pricing';
  const first = await loadRunProgress(store, charge);
  await assert.rejects(first.chargePage(url), /Could not save progress/);

  saveFails = false;
  const retry = await loadRunProgress(store, charge);
  assert.equal(retry.hasCharged(url), false);
  await retry.chargePage(url);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].eventName, 'page-checked');
  assert.match(requests[1].idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(values.get('RUN_PROGRESS'), [url]);

  const restarted = await loadRunProgress(store, charge);
  assert.equal(restarted.hasCharged(url), true);
  assert.equal(restarted.hasCharged('https://example.org/pricing'), false);
});
