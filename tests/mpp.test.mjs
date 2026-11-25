import assert from 'node:assert/strict';
import test from 'node:test';
import { Challenge, Credential, Store } from 'mppx';
import { Attribution } from 'mppx/tempo';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { createMppRail, mppBlobsStore, mppConfig, mppPath, tempoOusd } from '../lib/payments/mpp.mjs';
import { makeQuote, readQuote } from '../lib/payments/quotes.mjs';

const origin = new URL('https://phantompipe.com');
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

test('separate ten-cent row quotes create distinct 0.10 OUSD Tempo challenges', async () => {
  const { handler } = setup(createMppRail({ origin, recipient, secretKey, testnet: true, store: Store.memory() }));
  const rows = ['row-1', 'row-2'].map((row) =>
    makeQuote({ amount_cents: 10, description: `Evidence brief: ${row}` }, signingSecret));
  const challenges = [];
  for (const { token } of rows) {
    const response = await handler(request(token));
    assert.equal(response.status, 402);
    const challenge = Challenge.fromResponse(response);
    assert.equal(challenge.method, 'tempo');
    assert.equal(challenge.request.currency.toLowerCase(), tempoOusd);
    assert.equal(challenge.request.amount, '100000');
    challenges.push(challenge);
  }
  assert.notEqual(challenges[0].id, challenges[1].id);
});

test('the durable MPP link redirects to a fixed-price quote for a 1.00 OUSD challenge', async () => {
  const { handler, values } = setup(createMppRail({ origin, recipient, secretKey, testnet: true, store: Store.memory() }));
  const url = new URL(`${mppPath}?product=evidence-brief-10&amount_cents=1`, origin);
  const response = await handler(new Request(url));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const final = new URL(response.headers.get('Location'), origin);
  assert.equal(final.origin, origin.origin);
  assert.equal(final.pathname, mppPath);
  assert.equal(final.searchParams.has('product'), false);
  const quote = readQuote(final.searchParams.get('quote'), signingSecret);
  assert.equal(quote.amount_cents, 100);
  const challengeResponse = await handler(new Request(final));
  assert.equal(challengeResponse.status, 402);
  const challenge = Challenge.fromResponse(challengeResponse);
  assert.equal(challenge.method, 'tempo');
  assert.equal(challenge.request.currency.toLowerCase(), tempoOusd);
  assert.equal(challenge.request.amount, '1000000');
  assert.equal(values.size, 0);

  const another = await handler(new Request(url));
  const anotherToken = new URL(another.headers.get('Location'), origin).searchParams.get('quote');
  assert.notEqual(readQuote(anotherToken, signingSecret).id, quote.id);
  const credential = Credential.serialize({ challenge, payload: { type: 'hash', hash: tx } });
  const wrongEndpoint = await handler(new Request(url, { headers: { Authorization: credential } }));
  assert.equal(wrongEndpoint.status, 400);
  assert.deepEqual(await wrongEndpoint.json(), { error: 'use_signed_quote_url' });
  const unknown = await handler(new Request(new URL(`${mppPath}?product=not-listed`, origin)));
  assert.equal(unknown.status, 404);
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

test('a settled MPP pull can recover from a failed transaction claim without resettling', async (t) => {
  let settlements = 0;
  const { handler, store } = setup({
    testnet: false,
    verify: async () => ({ push: false }),
    async settle() {
      assert.equal(++settlements, 1);
      return { transaction: tx, header: 'signed-receipt' };
    },
  });
  const add = store.add;
  let failTransactionClaim = true;
  t.mock.method(store, 'add', async (key, value) => {
    if (key === `mpp-transaction/${tx}` && failTransactionClaim) throw new Error('Temporary write failure');
    return add(key, value);
  });
  t.mock.method(console, 'error', () => {});
  const { token } = issue();
  assert.equal((await handler(request(token, 'Payment test'))).status, 502);
  failTransactionClaim = false;
  const paid = await handler(request(token, 'Payment test'));
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get('Payment-Receipt'), 'signed-receipt');
  assert.equal((await paid.json()).payment_id, tx);
  assert.equal((await handler(request(token, 'Payment test'))).status, 409);
});

test('late MPP push proofs credit only a bound transfer mined by the signed deadline', async (t) => {
  const start = Math.floor(Date.now() / 1000) * 1000;
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const from = '0x0000000000000000000000000000000000000043';
  const abi = parseAbi(['event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)']);
  for (const expiresIn of [60, 600]) {
    now = start;
    const { token } = makeQuote({ amount_cents: 50, description: 'Test quote', expiresIn }, signingSecret);
    let receipt;
    let minedAt;
    const rpc = {
      getTransactionReceipt: async ({ hash }) => { assert.equal(hash, tx); return receipt; },
      getBlock: async ({ blockHash }) => {
        assert.equal(blockHash, tx);
        return { timestamp: minedAt / 1000n, timestampMillis: `0x${minedAt.toString(16)}` };
      },
    };
    const { handler } = setup(createMppRail({ origin, recipient, secretKey, testnet: true, store: Store.memory(), rpc }));
    const challenge = Challenge.fromResponse(await handler(request(token)));
    const authorization = Credential.serialize({ challenge, payload: { type: 'hash', hash: tx } });
    const memo = Attribution.encode({ challengeId: challenge.id, serverId: origin.hostname });
    const log = (overrides = {}) => {
      const args = { from, to: recipient, memo, amount: 500_000n, address: tempoOusd, ...overrides };
      return {
        address: args.address,
        topics: encodeEventTopics({ abi, eventName: 'TransferWithMemo', args }),
        data: encodeAbiParameters([{ type: 'uint256' }], [args.amount]),
      };
    };
    receipt = { status: 'success', transactionHash: tx, blockHash: tx, from, logs: [log()] };
    const deadline = Date.parse(challenge.expires);
    assert.equal(deadline, start + Math.min(expiresIn, 300) * 1000);
    now = deadline + 2000;

    minedAt = BigInt(deadline) + 1n;
    assert.equal((await handler(request(token, authorization))).status, 410);
    minedAt -= 1n;
    for (const invalid of [{ to: from }, { amount: 499_999n }, { address: from }, { memo: tx }]) {
      receipt.logs = [log(invalid)];
      assert.equal((await handler(request(token, authorization))).status, 402);
    }
    receipt.logs = [log()];
    const wrongQuote = makeQuote({ amount_cents: 50, description: 'Other quote' }, signingSecret, start / 1000);
    assert.equal((await handler(request(wrongQuote.token, authorization))).status, 402);

    const paid = await handler(request(token, authorization));
    assert.equal(paid.status, 200);
    assert.ok(paid.headers.get('Payment-Receipt'));
    assert.equal((await paid.json()).payment_id, tx);
    const replay = await handler(request(token, authorization));
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error, 'payment_replayed');
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
