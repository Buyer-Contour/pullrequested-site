import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentState, paymentStores } from '../workers/payment-state.mjs';

function stores() {
  const entries = new Map();
  const kv = { get: entries.get.bind(entries), put: entries.set.bind(entries), delete: entries.delete.bind(entries) };
  return paymentStores(paymentState({ kv, transactionSync: (fn) => fn() }));
}

test('the Workers quote store reserves an unused key only once under concurrent writes', async () => {
  const { quotes } = stores();
  assert.equal(await quotes.get('reservation'), null);
  const outcomes = await Promise.all([
    quotes.add('reservation', { channel: 'checkout' }),
    quotes.add('reservation', { channel: 'mpp' }),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await quotes.get('reservation')).channel, outcomes[0] ? 'checkout' : 'mpp');
});

test('the Workers MPP store retries competing updates against the latest version', async () => {
  const { mpp } = stores();
  await mpp.put('counter', 0);
  const increment = () => mpp.update('counter', (value) => ({ op: 'set', value: value + 1, result: value + 1 }));
  const results = await Promise.all([increment(), increment()]);
  assert.deepEqual(results.sort(), [1, 2]);
  assert.equal(await mpp.get('counter'), 2);
  assert.equal(await mpp.update('counter', (value) => ({ op: 'noop', result: value })), 2);
  assert.equal(await mpp.update('counter', (value) => ({ op: 'delete', result: value })), 2);
  assert.equal(await mpp.get('counter'), null);
});
