import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
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

test('the Worker quote page renders with Tempo configured and no Stripe credentials', async () => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return { url: 'data:text/javascript,export%20class%20DurableObject%20%7B%7D', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  let worker;
  try {
    ({ default: worker } = await import('../workers/payments.mjs'));
  } finally {
    hooks.deregister();
  }
  const env = {
    PAYMENTS_ORIGIN: 'https://phantompipe-payments.example.com',
    WORKER_QUOTE_SIGNING_SECRET: 'worker-test-signer-that-is-long-enough',
    MPP_NETWORK: 'tempo',
    MPP_PAY_TO: '0x0000000000000000000000000000000000000042',
    MPP_SECRET_KEY: 'test MPP secret at least 32 bytes',
  };
  for (const [amount_cents, total] of [[10, '$0.10'], [500, '$5.00']]) {
    const { token } = makeQuote({ amount_cents, description: 'Tempo quote' }, env.WORKER_QUOTE_SIGNING_SECRET);
    const response = await worker.fetch(new Request(`${env.PAYMENTS_ORIGIN}/q/${token}`), env);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes(`Total: ${total} USD`));
    assert.ok(body.includes(`href="/api/mpp/pay?quote=${token}"`));
    assert.doesNotMatch(body, /\/api\/checkout/);
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
