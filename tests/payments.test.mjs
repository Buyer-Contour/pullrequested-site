import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setEnvironmentContext } from '@netlify/blobs';
import Stripe from 'stripe';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { checkoutVerificationDescription, makeAgentVerificationQuote } from '../lib/payments/live-verification.mjs';
import { makeQuote, readQuote } from '../lib/payments/quotes.mjs';
import { paymentConfig } from '../lib/payments/runtime.mjs';
import netlifyMppPay from '../netlify/functions/mpp-pay.mjs';
import netlifyQuotePage from '../netlify/functions/quote-page.mjs';

const signingSecret = 'test-only-quote-signing-key-32-bytes';
const webhookSecret = 'whsec_test_fixture';
const testNow = 1_780_000_000;
const origin = 'https://phantompipe.com';
const intentId = 'pi_test123';
const sessionId = 'cs_test_123';
const quoteAt = (description = 'Quoted work', expiresIn) =>
  makeQuote({ amount_cents: 500, description, expiresIn }, signingSecret, testNow);
const to = (path, token) => new URL(`${path}?quote=${token}`, origin);

function fixture({ testMode = true, publishableKey, afterAdd } = {}) {
  let clock = testNow;
  const entries = new Map();
  const calls = { checkout: [], agent: [], methods: [] };
  const intents = new Map();
  const methods = new Map();
  const store = {
    async get(key) { return entries.get(key); },
    async add(key, value) {
      if (entries.has(key)) return false;
      entries.set(key, value);
      afterAdd?.(key, (seconds) => { clock += seconds; });
      return true;
    },
  };
  const stripe = {
    webhooks: new Stripe('sk_test_fixture').webhooks,
    checkout: { sessions: { async create(params, options) {
      calls.checkout.push({ params, options });
      return { id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` };
    } } },
    paymentMethods: { async retrieve(id) {
      calls.methods.push(id);
      if (!methods.has(id)) throw Object.assign(new Error('No such PaymentMethod'), { code: 'resource_missing' });
      return methods.get(id);
    } },
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
  const handlers = createPaymentHandlers({ stripe, store, origin, testMode, publishableKey, signingSecret, webhookSecret, now: () => clock });
  function webhookRequest(session, { secret = webhookSecret, type = 'checkout.session.completed' } = {}) {
    const payload = JSON.stringify({ type, livemode: !testMode, data: { object: session } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return new Request(`${origin}/api/stripe-webhook`, {
      method: 'POST', body: payload, headers: { 'Stripe-Signature': signature },
    });
  }
  return { handlers, entries, calls, intents, methods, webhookRequest, tick: (secs) => { clock += secs; } };
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

test('a five-cent quote offers only Tempo MPP and cannot reserve a Stripe payment', async () => {
  const { token, quote } = makeQuote({ amount_cents: 5, description: 'Evidence brief row' }, signingSecret, testNow);
  const { handlers, entries, calls } = fixture();
  const page = await handlers.page(new Request(to('/q', token)));
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Total: \$0\.05 USD/);
  assert.ok(body.includes(`href="/api/mpp/pay?quote=${token}"`));
  assert.doesNotMatch(body, /\/api\/checkout|Continue to Stripe Checkout/);

  const checkoutGet = await handlers.checkout(new Request(to('/api/checkout', token), { method: 'GET' }));
  assert.equal(checkoutGet.status, 303);
  assert.equal(checkoutGet.headers.get('Location'), `/q/${token}`);

  const { nonce } = readQuote(token, signingSecret, { now: testNow });
  for (const response of await Promise.all([
    handlers.pay(getPayment(token)),
    handlers.pay(getPayment(token, intentId)),
    handlers.pay(postPayment(token, { nonce, payment_method: 'pm_card_visa' })),
  ])) {
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'quote_requires_tempo_mpp' });
  }
  assert.equal(entries.has(`reservation/${quote.id}`), false);
  assert.deepEqual(calls, { checkout: [], agent: [], methods: [] });
});

test('the durable quote link issues new fixed-price quotes for Tempo MPP without opening Stripe Checkout', async () => {
  const { handlers, entries, calls, tick } = fixture();
  const product = 'evidence-brief-10';
  const open = () => handlers.page(new Request(`${to('/q', product)}&amount_cents=1`));
  const first = await open();
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.equal(first.headers.get('Referrer-Policy'), 'no-referrer');
  const firstToken = new URL(first.headers.get('Location'), origin).pathname.slice(3);
  const quote = readQuote(firstToken, signingSecret, { now: testNow });
  assert.equal(quote.amount_cents, 100);
  assert.equal(quote.description, '20-row evidence brief (20 accepted rows at $0.05 each)');
  const page = await handlers.page(new Request(to('/q', firstToken)));
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.ok(body.includes(quote.description));
  assert.match(body, /Total: \$1\.00 USD \(1\.00 OUSD on Tempo\)/);
  assert.ok(body.includes(`href="/api/mpp/pay?quote=${firstToken}"`));
  assert.doesNotMatch(body, /Stripe Checkout|checkout\.stripe\.com/i);

  tick(24 * 60 * 60);
  assert.equal((await handlers.page(new Request(to('/q', firstToken)))).status, 410);
  const later = await open();
  assert.equal(later.status, 303);
  const laterToken = new URL(later.headers.get('Location'), origin).pathname.slice(3);
  const laterQuote = readQuote(laterToken, signingSecret, { now: testNow + 24 * 60 * 60 });
  assert.notEqual(laterQuote.id, quote.id);
  assert.ok(laterQuote.expires_at > quote.expires_at);
  assert.equal(laterQuote.amount_cents, 100);
  assert.equal(entries.size, 0);
  assert.equal(calls.checkout.length, 0);
  const checkout = await handlers.checkout(new Request(to('/api/checkout', laterToken), { method: 'POST' }));
  assert.equal(checkout.status, 303);
  assert.equal(checkout.headers.get('Location'), `/q/${laterToken}`);
  assert.equal(calls.checkout.length, 0);
  assert.equal((await handlers.page(new Request(to('/q', 'other-product')))).status, 400);
});

test('fixed-price services route to Tempo MPP and never open Stripe Checkout', async () => {
  const { handlers, calls } = fixture({ testMode: false });
  for (const [slug, amount] of [
    ['icp-lead-list', 1_400],
    ['crm-dedupe-enrichment', 2_800],
    ['competitor-teardown', 200],
    ['podcast-newsletter-placement', 200],
    ['local-business-review-replies', 100],
    ['agent-bill-audit', 100],
    ['scraper-parser', 200],
  ]) {
    const tag = `v=svc-${slug}`;
    const opened = await handlers.page(new Request(`${to('/q', slug)}&${tag}&amount_cents=1`));
    assert.equal(opened.status, 303);
    const signed = new URL(opened.headers.get('Location'), origin);
    assert.equal(signed.search, '?' + tag);
    const token = signed.pathname.slice(3);
    const quote = readQuote(token, signingSecret, { now: testNow });
    assert.equal(quote.service_slug, slug);
    assert.equal(quote.amount_cents, amount);
    const page = await handlers.page(new Request(`${to('/q', token)}&${tag}`));
    const body = await page.text();
    assert.ok(body.includes(`href="/api/mpp/pay?quote=${token}&amp;${tag}"`));
    assert.ok(body.includes(`href="/quote/?${tag}"`));
    assert.doesNotMatch(body, /Stripe Checkout|checkout\.stripe\.com/i);
    assert.equal((await handlers.pay(getPayment(token))).status, 422);

    const checkout = await handlers.checkout(new Request(`${to('/api/checkout', token)}&${tag}`, { method: 'POST' }));
    assert.equal(checkout.status, 303);
    assert.equal(checkout.headers.get('Location'), `/q/${token}?${tag}`);
    assert.equal(calls.checkout.length, 0);

    const isCrm = slug === 'crm-dedupe-enrichment';
    const quoteReference = isCrm ? `&quote_id=${quote.id}` : '';
    const submitted = await handlers.page(new Request(`${origin}/payment/submitted?service=${slug}${quoteReference}&${tag}&result=submitted`));
    const intake = await submitted.text();
    assert.match(intake, /Tempo MPP payment receipt/);
    assert.match(intake, /mailto:dane@phantompipe.com/);
    assert.ok(intake.includes(`href="/quote?${tag}"`));
    if (isCrm) {
      assert.match(intake, /Email your CSV or a share link/);
      assert.ok(intake.includes(`quote ID (<strong>${quote.id}</strong>) in the subject`));
    } else {
      assert.doesNotMatch(intake, /Email your CSV/);
    }
  }
});

test('the Netlify quote page renders with Tempo configured and no Stripe credentials', async (t) => {
  const originalEnv = process.env;
  process.env = {
    PAYMENTS_ORIGIN: origin,
    QUOTE_SIGNING_SECRET: signingSecret,
    MPP_NETWORK: 'tempo',
    MPP_PAY_TO: '0x0000000000000000000000000000000000000042',
    MPP_SECRET_KEY: 'test MPP secret at least 32 bytes',
  };
  t.after(() => { process.env = originalEnv; });
  const { token } = makeQuote({ amount_cents: 5, description: 'Evidence brief row' }, signingSecret);
  const response = await netlifyQuotePage(new Request(to('/q', token)));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Total: \$0\.05 USD/);
  assert.ok(body.includes(`href="/api/mpp/pay?quote=${token}"`));
  assert.doesNotMatch(body, /\/api\/checkout/);
});

test('Netlify payment functions mint both durable links with the configured signer', async (t) => {
  const originalEnv = process.env;
  process.env = {
    PAYMENTS_ORIGIN: origin,
    QUOTE_SIGNING_SECRET: signingSecret,
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    MPP_NETWORK: 'moderato',
    MPP_PAY_TO: '0x0000000000000000000000000000000000000042',
    MPP_SECRET_KEY: 'test MPP secret at least 32 bytes',
  };
  t.after(() => { process.env = originalEnv; });
  setEnvironmentContext({ siteID: 'test-site', token: 'test-token', apiURL: 'https://blobs.example.invalid' });

  const product = 'evidence-brief-10';
  const card = await netlifyQuotePage(new Request(to('/.netlify/functions/quote-page', product)));
  const mpp = await netlifyMppPay(new Request(`${origin}/.netlify/functions/mpp-pay?product=${product}`));
  assert.equal(card.status, 303);
  assert.equal(mpp.status, 303);
  const cardToken = new URL(card.headers.get('Location'), origin).pathname.slice(3);
  const mppToken = new URL(mpp.headers.get('Location'), origin).searchParams.get('quote');
  assert.equal(readQuote(cardToken, signingSecret).amount_cents, 100);
  assert.equal(readQuote(mppToken, signingSecret).amount_cents, 100);
});

test('quote page escapes descriptions, /api/checkout redirects back to /q without Stripe, and webhooks stay verified', async () => {
  const { quote, token } = quoteAt('<script>unsafe</script>');
  const { handlers, calls, entries, webhookRequest } = fixture();
  const page = await handlers.page(new Request(to('/q', token)));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  const body = await page.text();
  assert.match(body, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(body, /<h1>Pay your Phantom Pipe quote<\/h1>/);
  assert.doesNotMatch(body, /Stripe Checkout|checkout\.stripe\.com/i);
  const checkout = () => handlers.checkout(new Request(to('/api/checkout', token)));
  const first = await checkout();
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('Location'), `/q/${token}`);
  assert.equal(calls.checkout.length, 0);
  const metadata = { quote_id: quote.id, quote_fingerprint: quote.fingerprint, source: 'pullrequested' };
  entries.set(`reservation/${quote.id}`, {
    channel: 'checkout',
    source: 'pullrequested',
    quote_fingerprint: quote.fingerprint,
    amount: quote.amount_cents,
    currency: 'usd',
  });
  const session = {
    id: sessionId, mode: 'payment', payment_status: 'paid', amount_total: quote.amount_cents, currency: 'usd', metadata,
  };
  assert.equal((await handlers.webhook(webhookRequest(session, { secret: 'wrong' }))).status, 400);
  assert.equal((await handlers.webhook(webhookRequest({ ...session, metadata: { ...session.metadata, source: undefined } }))).status, 200);
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

test('an expired quote cannot start a payment or redirect from checkout', async () => {
  const { handlers, calls, tick } = fixture();
  const { token } = quoteAt('Soon', 60);
  tick(60);
  assert.equal((await handlers.checkout(new Request(to('/api/checkout', token)))).status, 410);
  const expired = await handlers.pay(getPayment(token));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, 'quote_expired');
  assert.equal(calls.checkout.length, 0);
  assert.equal(calls.agent.length, 0);
});

test('agent challenge binds quote, amount, currency, nonce and rejects concurrent and later replays', async () => {
  const { quote, token } = quoteAt();
  const { handlers, calls, intents, tick } = fixture();
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
  assert.deepEqual(calls.methods, [], 'Stripe test fixture is confirmed directly, not looked up');
  assert.equal(calls.agent[0].params.metadata.nonce, nonce);
  assert.equal(calls.agent[0].params.metadata.source, 'pullrequested');
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
  tick(23 * 60 * 60);
  assert.equal((await handlers.pay(getPayment(token))).status, 409);
});

test('Stripe shared payment tokens remain supported and cannot swap credentials', async () => {
  const { token } = quoteAt();
  const { handlers, calls } = fixture({ testMode: false });
  const challenge = await (await handlers.pay(getPayment(token))).json();
  const { nonce } = challenge;
  assert.ok(!challenge.payment.test_only_alternative);
  assert.ok(!challenge.payment.stripe);
  assert.equal((await handlers.pay(postPayment(token, { nonce, payment_method: 'pm_card_visa' }))).status, 400);
  assert.equal((await handlers.pay(postPayment(token, { nonce, shared_payment_token: 'spt_first' }))).status, 200);
  assert.equal((await handlers.pay(postPayment(token, { nonce, shared_payment_token: 'spt_second' }))).status, 409);
  assert.equal(calls.agent.length, 1);
  assert.deepEqual(calls.agent[0].params.payment_method_data, { shared_payment_granted_token: 'spt_first' });
  assert.equal(calls.agent[0].params.shared_payment_granted_token, undefined);
  assert.match(calls.agent[0].options.apiVersion, /\.preview$/);
  assert.equal(calls.agent[0].options.apiVersion, '2026-09-30.preview');
});

test('payment runtime accepts a same-mode publishable key and never publishes a secret key', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_fixture', PAYMENTS_ORIGIN: origin, QUOTE_SIGNING_SECRET: signingSecret };
  assert.equal(paymentConfig(env).publishableKey, undefined);
  assert.equal(paymentConfig({ ...env, STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture' }).publishableKey, 'pk_test_fixture');
  for (const invalid of ['sk_test_fixture', 'pk_live_fixture']) {
    assert.throws(() => paymentConfig({ ...env, STRIPE_PUBLISHABLE_KEY: invalid }), /must be a Stripe publishable key in the same mode/);
  }
  const live = { PAYMENTS_ORIGIN: origin, QUOTE_SIGNING_SECRET: signingSecret };
  assert.throws(() => paymentConfig({ ...live, STRIPE_SECRET_KEY: 'sk_live_fixture' }), /require STRIPE_LIVE_RESTRICTED_KEY/);
  assert.throws(() => paymentConfig({ ...live, STRIPE_LIVE_RESTRICTED_KEY: 'sk_live_fixture' }), /must be a restricted live key/);
  assert.equal(paymentConfig({ ...live, STRIPE_LIVE_RESTRICTED_KEY: 'rk_live_fixture', STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture' }).testMode, false);
});

test('live agent verification page accepts only signed $1 verification quotes and expires after 15 minutes', async () => {
  const { handlers, tick } = fixture({ testMode: false, publishableKey: 'pk_live_fixture' });
  const view = (token) => handlers.agentVerification(new Request(to('/agent-pay-test', token)));
  assert.equal((await view(quoteAt().token)).status, 404);
  const { token } = makeAgentVerificationQuote(signingSecret, testNow);
  const response = await view(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const nonce = response.headers.get('Content-Security-Policy').match(/'nonce-([\w-]+)'/)[1];
  const body = await response.text();
  assert.match(body, /<title>Agent payment verification \| Phantom Pipe<\/title>/);
  assert.match(body, new RegExp(`nonce="${nonce}"`));
  assert.match(body, /stripe\.createPaymentMethod/);
  assert.match(body, /replay\.status !== 409/);
  assert.ok(!body.includes(token));
  tick(15 * 60);
  assert.equal((await view(token)).status, 410);
});

test('an agent quote expiring while writing the reservation cannot start a Stripe charge', async () => {
  const { token } = quoteAt('Expiring agent quote', 60);
  const { handlers, calls } = fixture({
    afterAdd: (key, tick) => { if (key.startsWith('reservation/')) tick(60); },
  });
  const { nonce } = await (await handlers.pay(getPayment(token))).json();
  const response = await handlers.pay(postPayment(token, { nonce, payment_method: 'pm_card_visa' }));
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error, 'quote_expired');
  assert.equal(calls.agent.length, 0);
});

test('402 advertises Stripe.js and only accepts a new, unattached card PaymentMethod from the right Stripe mode', async () => {
  const publishableKey = 'pk_live_fixture';
  const { token, quote } = quoteAt();
  const { handlers, calls, entries, methods } = fixture({ testMode: false, publishableKey });
  const response = await handlers.pay(getPayment(token));
  assert.equal(response.status, 402);
  const { nonce, payment } = await response.json();
  assert.equal(payment.stripe.publishable_key, publishableKey);
  assert.equal(payment.stripe.tokenize.method, 'stripe.createPaymentMethod');
  assert.match(payment.stripe.tokenize.url, /^https:\/\/docs\.stripe\.com\//);
  assert.ok(payment.fields.payment_method);
  assert.ok(payment.fields.shared_payment_token);

  const id = 'pm_cardFixture123';
  const goodMethod = { customer: null, type: 'card', created: testNow, livemode: true };
  const post = (body) => handlers.pay(postPayment(token, { nonce, ...body }));
  assert.equal((await post({ payment_method: 'pm_card_visa' })).status, 400);
  assert.equal((await post({ payment_method: id, shared_payment_token: 'spt_test' })).status, 400);
  assert.equal((await post({ payment_method: id, nonce: 'wrong' })).status, 402);
  assert.deepEqual(calls.methods, []);

  const unknown = await post({ payment_method: id });
  assert.equal(unknown.status, 402);
  assert.equal((await unknown.json()).error, 'payment_method_not_found');
  for (const [fields, error] of [
    [{ customer: 'cus_123' }, 'payment_method_attached_to_customer'],
    [{ customer: { id: 'cus_123' } }, 'payment_method_attached_to_customer'],
    [{ created: testNow - 1 }, 'payment_method_not_eligible'],
    [{ type: 'us_bank_account' }, 'payment_method_not_eligible'],
    [{ livemode: false }, 'payment_method_not_eligible'],
  ]) {
    methods.set(id, { ...goodMethod, ...fields });
    const response = await post({ payment_method: id });
    assert.equal(response.status, 402);
    assert.equal((await response.json()).error, error);
  }
  assert.equal(entries.has(`reservation/${quote.id}`), false);
  assert.equal(calls.agent.length, 0);

  methods.set(id, goodMethod);
  const confirmation = await post({ payment_method: id });
  assert.equal(confirmation.status, 200);
  const { payment_intent_id } = await confirmation.json();
  assert.equal(calls.agent[0].params.payment_method, id);
  assert.ok(!('customer' in calls.agent[0].params));
  assert.ok(!('apiVersion' in calls.agent[0].options));
  const results = await Promise.all([1, 2].map(() => handlers.pay(getPayment(token, payment_intent_id))));
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  assert.equal((await results.find((item) => item.status === 409).json()).error, 'payment_replayed');
});
