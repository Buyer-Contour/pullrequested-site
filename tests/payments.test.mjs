import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { makeQuote, readQuote } from '../lib/payments/quotes.mjs';

const signingSecret = 'test-only-quote-signing-key-32-bytes';
const webhookSecret = 'whsec_test_fixture';
const testNow = 1_780_000_000;
const origin = 'https://pullrequested.com';
const intentId = 'pi_test123';
const sessionId = 'cs_test_123';
const quoteAt = (description = 'Quoted work', expiresIn) =>
  makeQuote({ amount_cents: 500, description, expiresIn }, signingSecret, testNow);
const to = (path, token) => new URL(`${path}?quote=${token}`, origin);

function fixture({ testMode = true } = {}) {
  let clock = testNow;
  const entries = new Map();
  const calls = { checkout: [], agent: [] };
  const intents = new Map();
  const store = {
    async get(key) { return entries.get(key); },
    async add(key, value) {
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
  };
  const stripe = {
    webhooks: new Stripe('sk_test_fixture').webhooks,
    checkout: { sessions: { async create(params, options) {
      calls.checkout.push({ params, options });
      return { id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` };
    } } },
    paymentIntents: {
      async create(params, options) {
        calls.agent.push({ params, options });
        const intent = { ...params, id: intentId, amount_received: params.amount, status: 'succeeded', livemode: !testMode };
        intents.set(intentId, intent);
        return intent;
      },
      async retrieve(id) { return intents.get(id); },
    },
  };
  const handlers = createPaymentHandlers({ stripe, store, origin, testMode, signingSecret, webhookSecret, now: () => clock });
  function webhookRequest(session, { secret = webhookSecret, type = 'checkout.session.completed' } = {}) {
    const payload = JSON.stringify({ type, livemode: !testMode, data: { object: session } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return new Request(`${origin}/api/stripe-webhook`, {
      method: 'POST', body: payload, headers: { 'Stripe-Signature': signature },
    });
  }
  return { handlers, entries, calls, intents, webhookRequest, tick: (secs) => { clock += secs; } };
}

function postPayment(token, body) {
  return new Request(to('/api/pay', token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const getPayment = (token, proof) => new Request(to('/api/pay', token), { headers: proof ? { 'X-PAYMENT': proof } : {} });

test('quotes bind every field and expire even on their exact deadline', () => {
  const { quote, token } = quoteAt('Consulting', 60);
  assert.equal(quote.currency, 'usd');
  assert.equal(readQuote(token, signingSecret, { now: testNow }).id, quote.id);
  const [body, signature] = token.split('.');
  const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), amount_cents: 50 })).toString('base64url');
  for (const candidate of [`${modified}.${signature}`, token.slice(0, -1), `${token}=`]) {
    assert.throws(() => readQuote(candidate, signingSecret, { now: testNow }), { status: 400, message: 'invalid_quote' });
  }
  assert.throws(() => readQuote(token, signingSecret, { now: testNow + 60 }), { status: 410, message: 'quote_expired' });
  assert.throws(() => quoteAt('Consulting', 24 * 60 * 60), /Invalid quote/);
});

test('checkout displays an escaped quote, creates one session, and records a verified paid webhook once', async () => {
  const { quote, token } = quoteAt('<script>unsafe</script>');
  const { handlers, calls, entries, webhookRequest } = fixture();
  const page = await handlers.page(new Request(to('/q', token)));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(await page.text(), /&lt;script&gt;unsafe&lt;\/script&gt;/);
  const checkout = () => handlers.checkout(new Request(to('/api/checkout', token)));
  const first = await checkout();
  assert.equal(first.status, 303);
  assert.equal((await checkout()).headers.get('Location'), first.headers.get('Location'));
  assert.equal(calls.checkout.length, 1);
  const [{ params, options }] = calls.checkout;
  assert.equal(params.metadata.quote_id, quote.id);
  assert.equal(params.payment_intent_data.metadata.quote_id, quote.id);
  assert.equal(params.expires_at, quote.expires_at);
  assert.equal(params.line_items[0].price_data.unit_amount, quote.amount_cents);
  assert.equal(params.success_url, origin + '/payment/submitted');
  assert.equal(params.cancel_url, `${origin}/q/${token}`);
  assert.equal(options.idempotencyKey, `quote-checkout-${quote.id}`);
  const session = {
    id: sessionId, mode: 'payment', payment_status: 'paid', amount_total: quote.amount_cents, currency: 'usd', metadata: params.metadata,
  };
  const { nonce } = await (await handlers.pay(getPayment(token))).json();
  const agent = await handlers.pay(postPayment(token, { nonce, payment_method: 'pm_card_visa' }));
  assert.equal(agent.status, 409);
  assert.equal(calls.agent.length, 0);
  assert.equal((await handlers.webhook(webhookRequest(session, { secret: 'wrong' }))).status, 400);
  assert.equal((await handlers.webhook(webhookRequest({ ...session, payment_status: 'unpaid' }))).status, 200);
  assert.equal((await handlers.webhook(webhookRequest({ ...session, amount_total: 50 }))).status, 200);
  assert.equal(entries.get(`paid/${quote.id}`), undefined);
  assert.equal((await handlers.webhook(webhookRequest(session))).status, 200);
  const paid = entries.get(`paid/${quote.id}`);
  assert.equal(paid.payment_id, sessionId);
  assert.equal(paid.channel, 'checkout');
  assert.equal((await handlers.webhook(webhookRequest(session))).status, 200);
  assert.equal(entries.get(`paid/${quote.id}`), paid);
  assert.equal((await checkout()).status, 409);
});

test('an expired quote cannot start a payment and near-expiry Checkout cannot outlive the quote', async () => {
  const { handlers, calls, tick } = fixture();
  const { token } = quoteAt('Soon', 60);
  const checkout = () => handlers.checkout(new Request(to('/api/checkout', token)));
  assert.equal((await (await checkout()).json()).error, 'quote_too_close_to_expiry_for_checkout');
  tick(60);
  const expired = await handlers.pay(getPayment(token));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, 'quote_expired');
  assert.equal(calls.checkout.length, 0);
  assert.equal(calls.agent.length, 0);
});

test('agent challenge binds quote, amount, currency, nonce and rejects concurrent and later replays', async () => {
  const { quote, token } = quoteAt();
  const { handlers, calls, intents } = fixture();
  const challenge = await handlers.pay(getPayment(token));
  assert.equal(challenge.status, 402);
  const { nonce, amount_cents, currency, quote_id } = await challenge.json();
  assert.deepEqual({ amount_cents, currency, quote_id }, { amount_cents: quote.amount_cents, currency: 'usd', quote_id: quote.id });
  assert.equal((await handlers.pay(new Request(to('/api/pay', token), { method: 'POST' }))).status, 402);
  const post = (value) => handlers.pay(postPayment(token, { nonce: value, payment_method: 'pm_card_visa' }));
  assert.equal((await post('wrong')).status, 402);
  assert.equal(calls.agent.length, 0);
  const confirmed = await post(nonce);
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).payment_intent_id, intentId);
  assert.equal(calls.agent[0].params.metadata.nonce, nonce);
  assert.equal(calls.agent[0].options.idempotencyKey, `quote-agent-${quote.id}`);
  const checkout = await handlers.checkout(new Request(to('/api/checkout', token)));
  assert.equal(checkout.status, 409);
  assert.equal(calls.checkout.length, 0);

  const other = quoteAt('Another quote');
  assert.equal((await handlers.pay(getPayment(other.token, intentId))).status, 402);
  const redeem = () => handlers.pay(getPayment(token, intentId));
  const good = intents.get(intentId);
  for (const wrong of [
    { amount: 50 }, { amount_received: 50 }, { currency: 'eur' }, { status: 'requires_action' }, { livemode: true },
    { metadata: { ...good.metadata, quote_id: other.quote.id } }, { metadata: { ...good.metadata, nonce: 'wrong' } },
  ]) {
    intents.set(intentId, { ...good, ...wrong });
    assert.equal((await redeem()).status, 402);
  }
  intents.set(intentId, good);
  const results = await Promise.all([redeem(), redeem(), redeem()]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409, 409]);
  assert.deepEqual(await results.find((item) => item.status === 200).json(), {
    quote_id: quote.id, payment_id: intentId, channel: 'agent', status: 'paid', paid_at: new Date(testNow * 1000).toISOString(),
  });
  const replay = await redeem();
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'payment_replayed');
});

test('live agent payment requires a Stripe shared payment token and cannot swap credentials', async () => {
  const { token } = quoteAt();
  const { handlers, calls } = fixture({ testMode: false });
  const challenge = await (await handlers.pay(getPayment(token))).json();
  const { nonce } = challenge;
  assert.ok(!challenge.payment.test_only_alternative);
  assert.equal((await handlers.pay(postPayment(token, { nonce, payment_method: 'pm_card_visa' }))).status, 400);
  assert.equal((await handlers.pay(postPayment(token, { nonce, shared_payment_token: 'spt_first' }))).status, 200);
  assert.equal((await handlers.pay(postPayment(token, { nonce, shared_payment_token: 'spt_second' }))).status, 409);
  assert.equal(calls.agent.length, 1);
  assert.equal(calls.agent[0].params.shared_payment_granted_token, 'spt_first');
  assert.match(calls.agent[0].options.apiVersion, /\.preview$/);
});
