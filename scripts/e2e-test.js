const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const { paymentConfig } = await import('../lib/payments/runtime.mjs');
  const { makeQuote } = await import('../lib/payments/quotes.mjs');
  const { stripe, origin, testMode, publishableKey, signingSecret, webhookSecret } = paymentConfig();
  assert.ok(testMode, 'This script only runs with a Stripe test-mode key');
  const simulateDelivery = process.argv.includes('--local-webhook');
  if (simulateDelivery) {
    assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && webhookSecret,
      '--local-webhook requires a loopback server and STRIPE_WEBHOOK_SECRET');
  }
  const amount_cents = 500;
  const agent = makeQuote({ amount_cents, description: 'Agent quote payment — test only' }, signingSecret);
  const payUrl = new URL(`/api/pay?quote=${agent.token}`, origin);
  const challenge = await fetch(payUrl);
  assert.equal(challenge.status, 402, 'Expected an HTTP 402 challenge');
  const { nonce, quote_id, payment: requirements } = await challenge.json();
  assert.equal(quote_id, agent.quote.id);
  const useFixtureCard = process.argv.includes('--fixture-card');
  let payment_method = 'pm_card_visa';
  if (!useFixtureCard) {
    const key = requirements.stripe?.publishable_key;
    assert.ok(typeof key === 'string' && /^pk_test_[a-zA-Z0-9_]+$/.test(key),
      'Set STRIPE_PUBLISHABLE_KEY on the test payment service or pass --fixture-card to test with pm_card_visa');
    if (publishableKey) assert.ok(key === publishableKey, 'The advertised Stripe publishable key does not match the local one');
    const tokenize = await fetch('https://api.stripe.com/v1/payment_methods', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ type: 'card', 'card[token]': 'tok_visa' }),
    });
    assert.equal(tokenize.status, 200, `Stripe test card tokenization returned HTTP ${tokenize.status}`);
    const method = await tokenize.json();
    assert.equal(method.customer, null);
    assert.equal(method.livemode, false);
    assert.match(method.id, /^pm_[a-zA-Z0-9]+$/);
    payment_method = method.id;
  }
  const payment = await fetch(payUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, payment_method }),
  });
  assert.equal(payment.status, 200, `Agent confirmation returned HTTP ${payment.status}`);
  const { payment_intent_id } = await payment.json();
  assert.equal((await stripe.paymentIntents.retrieve(payment_intent_id)).status, 'succeeded');
  const headers = { 'X-PAYMENT': payment_intent_id };
  const redeem = await fetch(payUrl, { headers });
  assert.equal(redeem.status, 200);
  const receipt = await redeem.json();
  assert.equal(receipt.quote_id, agent.quote.id);
  assert.equal(receipt.status, 'paid');
  const replay = await fetch(payUrl, { headers });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'payment_replayed');
  console.log(`Agent (${useFixtureCard ? 'pm_card_visa fixture' : 'publishable-key tokenized card'}): Stripe PaymentIntent succeeded, quote receipt returned, replay rejected (HTTP 409).`);

  const human = makeQuote({ amount_cents, description: 'Human quote payment — test only' }, signingSecret);
  const checkoutUrl = new URL(`/api/checkout?quote=${human.token}`, origin);
  const create = await fetch(checkoutUrl, { redirect: 'manual' });
  assert.equal(create.status, 303);
  const hostedCheckout = new URL(create.headers.get('Location'));
  const sessionId = hostedCheckout.pathname.match(/\/((?:cs_test_)[a-zA-Z0-9]+)\/?$/)?.[1];
  assert.ok(sessionId, 'Expected Stripe’s default hosted test Checkout URL');
  console.log(`Human: open ${hostedCheckout.href}\nComplete Stripe Checkout with 4242 4242 4242 4242, a future date and any CVC.`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let session;
  while (Date.now() < deadline) {
    session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'complete' && session.payment_status === 'paid') break;
    await delay(3000);
  }
  assert.equal(session?.status, 'complete');
  assert.equal(session.payment_status, 'paid');
  assert.equal(session.amount_total, amount_cents);
  assert.equal(session.metadata.quote_id, human.quote.id);
  if (simulateDelivery) {
    const payload = JSON.stringify({
      livemode: false,
      type: 'checkout.session.completed',
      data: { object: session },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const webhook = await fetch(new URL('/api/stripe-webhook', origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: payload,
    });
    assert.equal(webhook.status, 200);
  }
  const webhookDeadline = Date.now() + 60_000;
  let status;
  do {
    status = await fetch(checkoutUrl, { redirect: 'manual' });
    if (status.status === 409) break;
    await delay(2000);
  } while (Date.now() < webhookDeadline);
  assert.equal(status.status, 409, 'Checkout did not record the paid quote; check webhook delivery');
  assert.equal((await status.json()).error, 'quote_already_paid');
  console.log(`Human: Stripe Checkout paid and quote recorded (${simulateDelivery ? 'locally simulated' : 'Stripe-delivered'} webhook).`);
}

main().catch((error) => {
  console.error(error.type ?? error.message);
  process.exitCode = 1;
});
