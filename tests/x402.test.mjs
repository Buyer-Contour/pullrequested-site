import assert from 'node:assert/strict';
import { test } from 'node:test';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { makeQuote } from '../lib/payments/quotes.mjs';
import { baseSepolia, createX402Rail, x402Path } from '../lib/payments/x402.mjs';

const origin = 'https://pullrequested.com';
const payTo = '0x1111111111111111111111111111111111111111';
const signingSecret = 'unit-test-quote-key-not-a-secret!';
const transaction = `0x${'2'.repeat(64)}`;
const signer = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const client = new x402Client().register(baseSepolia, new ExactEvmScheme(signer));
const quote = () => makeQuote({ amount_cents: 51, description: 'x402 unit test' }, signingSecret);

function setup() {
  const db = new Map();
  const calls = { verify: 0, settle: 0 };
  const store = {
    async get(key) { return db.get(key); },
    async add(key, value) {
      if (db.has(key)) return false;
      db.set(key, value);
      return true;
    },
  };
  const facilitator = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, network: baseSepolia, scheme: 'exact' }], extensions: [], signers: {} };
    },
    async verify() { calls.verify++; return { isValid: true, payer: signer.address }; },
    async settle() { calls.settle++; return { success: true, network: baseSepolia, transaction, payer: signer.address }; },
  };
  const x402Rail = createX402Rail({ facilitator, origin, network: baseSepolia, payTo });
  const handlers = createPaymentHandlers({ store, origin, signingSecret, x402Rail });
  const request = (token, proof) => handlers.x402(new Request(`${origin}${x402Path}?quote=${token}`, {
    headers: proof ? { 'Payment-Signature': proof } : {},
  }));
  return { handlers, store, calls, request };
}

test('native x402 provides Bazaar schemas, settles once, and rejects cross-quote proof replays', async () => {
  const { request, calls, handlers } = setup();
  const { token, quote: { id } } = quote();
  const challenge = await request(token);
  assert.equal(challenge.status, 402);
  const required = decodePaymentRequiredHeader(challenge.headers.get('Payment-Required'));
  assert.equal(required.resource.url, `${origin}${x402Path}`);
  assert.equal(required.accepts[0].amount, '510000');
  assert.equal(required.accepts[0].network, baseSepolia);
  assert.equal(required.accepts[0].payTo, payTo);
  assert.equal(required.extensions.bazaar.info.input.method, 'GET');
  assert.deepEqual(required.extensions.bazaar.schema.properties.input.properties.queryParams.required, ['quote']);
  assert.equal(required.extensions.bazaar.info.output.example.status, 'paid');
  assert.ok(!JSON.stringify(required).includes(token));
  const signed = await client.createPaymentPayload(required);
  const proof = encodePaymentSignatureHeader(signed);

  const outcomes = await Promise.all([request(token, proof), request(token, proof)]);
  assert.deepEqual(outcomes.map((result) => result.status).sort(), [200, 409]);
  assert.equal(calls.settle, 1);
  const paid = outcomes.find((result) => result.status === 200);
  assert.equal(decodePaymentResponseHeader(paid.headers.get('Payment-Response')).transaction, transaction);
  assert.equal((await paid.json()).quote_id, id);
  const replay = await request(quote().token, proof);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'payment_replayed');
  assert.equal((await handlers.checkout(new Request(`${origin}/api/checkout?quote=${token}`))).status, 409);
});

test('an incompatible x402 proof or a quote already reserved for Stripe cannot settle on-chain', async () => {
  const { request, calls, store } = setup();
  const { token, quote: { id } } = quote();
  const response = await request(token);
  const required = decodePaymentRequiredHeader(response.headers.get('Payment-Required'));
  const signed = await client.createPaymentPayload(required);
  const wrongAmount = { ...signed, accepted: { ...signed.accepted, amount: '10000' } };
  assert.equal((await request(token, encodePaymentSignatureHeader(wrongAmount))).status, 402);
  assert.equal(calls.verify, 0);
  await store.add(`reservation/${id}`, { channel: 'checkout' });
  assert.equal((await request(token, encodePaymentSignatureHeader(signed))).status, 409);
  assert.equal(calls.settle, 0);
});
