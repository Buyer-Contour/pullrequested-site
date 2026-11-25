import assert from 'node:assert/strict';
import test from 'node:test';
import { Challenge, Credential, Store } from 'mppx';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { createMppRail, mppBlobsStore, mppConfig, mppPath, tempoOusd } from '../lib/payments/mpp.mjs';
import { makeQuote } from '../lib/payments/quotes.mjs';

const origin = new URL('https://pullrequested.com');
const signingSecret = 'test quote secret at least 32 bytes';
const secretKey = 'test MPP secret at least 32 bytes';
const recipient = '0x0000000000000000000000000000000000000042';
const tx = `0x${'a'.repeat(64)}`;
const issue = () => makeQuote({ amount_cents: 50, description: 'Test quote' }, signingSecret);
const request = (token, authorization) => new Request(new URL(`${mppPath}?quote=${token}`, origin), {
  headers: authorization ? { Authorization: authorization } : {},
});

function setup(mppRail) {
  const values = new Map();
  const store = {
    get: async (key) => values.get(key),
    async add(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
  };
  return { handler: createPaymentHandlers({ store, origin, signingSecret, mppRail }).mpp, store, values };
}

test('MPP requires an explicitly configured network and emits a quote-bound Tempo challenge without Stripe', async () => {
  const env = { MPP_PAY_TO: recipient, MPP_SECRET_KEY: secretKey };
  assert.equal(mppConfig(env), null);
  const config = mppConfig({ ...env, MPP_NETWORK: 'moderato' });
  const { handler } = setup(createMppRail({ ...config, origin, store: Store.memory() }));
  const { token } = issue();
  const response = await handler(request(token));
  assert.equal(response.status, 402);
  const challenge = Challenge.fromResponse(response);
  assert.equal(challenge.method, 'tempo');
  assert.equal(challenge.intent, 'charge');
  assert.equal(challenge.request.recipient, recipient);
  assert.equal(challenge.request.amount, '500000');
  assert.equal(challenge.request.currency.toLowerCase(), tempoOusd);
  assert.equal(challenge.request.methodDetails.chainId, 42431);
  assert.equal(challenge.request.methodDetails.machineTokenEnabled, undefined);
  const credential = Credential.serialize({ challenge, payload: { type: 'hash', hash: tx } });
  const wrongQuote = await handler(request(issue().token, credential));
  assert.equal(wrongQuote.status, 402);
  assert.equal((await wrongQuote.json()).error, 'payment_not_verified');
});

test('MPP atomically rejects a replay, excludes other live rails, and isolates testnet', async () => {
  for (const testnet of [false, true]) {
    const { handler, store, values } = setup({
      testnet, verify: async () => {},
      settle: async () => ({ transaction: tx, header: 'signed-receipt' }),
    });
    const { token, quote } = issue();
    await store.add(`reservation/${quote.id}`, { channel: 'checkout' });
    const authorization = 'Payment test';
    if (!testnet) {
      assert.equal((await handler(request(token, authorization))).status, 409);
      values.delete(`reservation/${quote.id}`);
    }
    const paid = await handler(request(token, authorization));
    assert.equal(paid.status, 200);
    assert.equal(paid.headers.get('Payment-Receipt'), 'signed-receipt');
    assert.equal((await paid.json()).payment_id, tx);
    const replay = await handler(request(token, authorization));
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error, 'payment_replayed');
    assert.equal(values.has(`paid/${quote.id}`), !testnet);
    assert.equal(values.has(`mpp-testnet/paid/${quote.id}`), testnet);
  }
});

test('the MPP Blobs store applies SDK replay claims atomically across adapter instances', async () => {
  const records = new Map();
  let version = 0;
  const blobs = {
    getWithMetadata: async (key) => records.get(key) ?? null,
    async setJSON(key, data, condition) {
      const entry = records.get(key);
      if (condition.onlyIfNew ? entry : entry?.etag !== condition.onlyIfMatch) return { modified: false };
      records.set(key, { etag: String(++version), data });
      return { modified: true };
    },
  };
  const a = mppBlobsStore(blobs), b = mppBlobsStore(blobs);
  const expires = Date.now() + 60_000;
  const attempts = await Promise.all([Store.tryClaim(a, tx, expires, 'a'), Store.tryClaim(b, tx, expires, 'b')]);
  assert.equal(attempts.filter(Boolean).length, 1);
  await Store.releaseClaim(a, tx, attempts[0] ? 'b' : 'a');
  assert.equal(await Store.tryClaim(a, tx, expires), false);
  await Store.releaseClaim(b, tx, attempts[0] ? 'a' : 'b');
  assert.equal(await Store.tryClaim(a, tx, expires), true);
});
