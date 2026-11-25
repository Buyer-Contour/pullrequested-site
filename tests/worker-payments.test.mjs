import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { makeQuote } from '../lib/payments/quotes.mjs';
import { workerPaymentConfig } from '../workers/payment-config.mjs';
import { paymentState, paymentStores } from '../workers/payment-state.mjs';

function stores() {
  const entries = new Map();
  const kv = { get: entries.get.bind(entries), put: entries.set.bind(entries), delete: entries.delete.bind(entries) };
  return paymentStores(paymentState({ kv, transactionSync: (fn) => fn() }));
}

test('Workers require a separate quote signer and reject quotes signed for Netlify', async () => {
  const env = {
    PAYMENTS_ORIGIN: 'https://phantompipe-payments.example.com',
    QUOTE_SIGNING_SECRET: 'netlify-test-signer-that-is-long-enough',
    STRIPE_SECRET_KEY: 'sk_test_workerfixture',
  };
  const workerSecret = 'worker-test-signer-that-is-long-enough';
  for (const mppOnly of [false, true]) {
    assert.throws(() => workerPaymentConfig(env, { mppOnly }), /WORKER_QUOTE_SIGNING_SECRET/);
    assert.throws(() => workerPaymentConfig({
      ...env, WORKER_QUOTE_SIGNING_SECRET: env.QUOTE_SIGNING_SECRET,
    }, { mppOnly }), /WORKER_QUOTE_SIGNING_SECRET/);
    const config = workerPaymentConfig({ ...env, WORKER_QUOTE_SIGNING_SECRET: workerSecret }, { mppOnly });
    assert.equal(Boolean(config.stripe), !mppOnly);
    const handlers = createPaymentHandlers({
      ...config,
      store: stores().quotes,
      mppRail: { challenge: () => new Response(null, { status: 402 }) },
    });
    const path = mppOnly ? '/api/mpp/pay' : '/q/test';
    const handle = mppOnly ? handlers.mpp : handlers.page;
    const request = (secret) => {
      const { token } = makeQuote({ amount_cents: 50, description: 'Payment quote' }, secret);
      return new Request(new URL(`${path}?quote=${token}`, config.origin));
    };
    const rejected = await handle(request(env.QUOTE_SIGNING_SECRET));
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'invalid_quote' });
    assert.equal((await handle(request(workerSecret))).status, mppOnly ? 402 : 200);
  }
});

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
