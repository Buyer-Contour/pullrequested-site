import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { checkoutVerificationDescription, makeAgentVerificationQuote, refundVerificationPayment, verificationAmount } from '../lib/payments/live-verification.mjs';
import { makeQuote, readQuote } from '../lib/payments/quotes.mjs';
import { paymentConfig } from '../lib/payments/runtime.mjs';
import { stripeSource } from '../lib/payments/stripe-settings.mjs';

async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(3000);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function main() {
  assert.ok(process.argv.includes('--confirm-two-live-payments'), 'Requires approval for two USD 1.00 verification payments');
  const { stripe, origin, testMode, publishableKey, signingSecret } = paymentConfig();
  assert.ok(!testMode && publishableKey && origin.protocol === 'https:', 'Use the restricted live key, matching publishable key, and deployed HTTPS origin');
  const agent = makeAgentVerificationQuote(signingSecret);
  const { token } = makeQuote({ amount_cents: verificationAmount, description: checkoutVerificationDescription }, signingSecret);
  const human = { token, quote: readQuote(token, signingSecret) };
  const pageUrl = new URL(`/agent-pay-test?quote=${agent.token}`, origin);
  const agentUrl = new URL(`/api/pay?quote=${agent.token}`, origin);
  const checkoutUrl = new URL(`/api/checkout?quote=${human.token}`, origin);
  assert.equal((await fetch(pageUrl, { redirect: 'error' })).status, 200, 'The live agent verification page must be deployed');
  const challenge = await fetch(agentUrl, { redirect: 'error' });
  assert.equal(challenge.status, 402);
  assert.ok((await challenge.json()).payment.stripe?.publishable_key === publishableKey, 'Advertised live key did not match');
  const start = await fetch(checkoutUrl, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const hosted = new URL(start.headers.get('Location'));
  assert.equal(hosted.origin, 'https://checkout.stripe.com');
  const sessionId = hosted.pathname.match(/\/(cs_live_[a-zA-Z0-9]+)\/?$/)?.[1];
  assert.ok(sessionId, 'Expected the default Stripe live Checkout URL');
  console.log(`Agent USD 1.00 verification link (quote ${agent.quote.id}): ${pageUrl.href}`);
  console.log(`Human USD 1.00 Checkout link (quote ${human.quote.id}): ${hosted.href}`);
  console.log('Share these private links only with the authorized payer. The operator script will observe and refund each payment.');

  async function refund(quote, id, label) {
    console.log(`${label}: refunding the USD 1.00 verification payment on quote ${quote.id}.`);
    const result = await refundVerificationPayment(stripe, quote, id);
    assert.equal(result.status, 'succeeded', `${label} refund ${result.id} needs follow-up (${result.status})`);
    console.log(`${label}: refund succeeded (${result.id}).`);
  }

  async function monitorAgent() {
    const intent = await waitFor(async () => {
      const result = await stripe.paymentIntents.search({
        query: `status:'succeeded' AND metadata['source']:'${stripeSource}' AND metadata['quote_id']:'${agent.quote.id}'`, limit: 1,
      });
      return result.data[0];
    }, agent.quote.expires_at * 1000 + 2 * 60_000 - Date.now(), `Agent payment not found for quote ${agent.quote.id}; check Stripe before retrying`);
    await refund(agent.quote, intent.id, 'Agent');
    await waitFor(async () => (await fetch(agentUrl, { redirect: 'error' })).status === 409, 60_000, 'Agent verification page did not record a paid quote');
    const replay = await fetch(agentUrl, { headers: { 'X-PAYMENT': intent.id }, redirect: 'error' });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error, 'payment_replayed');
    console.log('Agent: paid receipt recorded and replay rejected (HTTP 409).');
  }

  async function monitorCheckout() {
    let session;
    try {
      session = await waitFor(async () => {
        const current = await stripe.checkout.sessions.retrieve(sessionId);
        return current.payment_status === 'paid' ? current : null;
      }, 15 * 60_000, `Checkout payment not found for quote ${human.quote.id}`);
    } finally {
      if (!session) {
        session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.status === 'open') {
          try {
            await stripe.checkout.sessions.expire(sessionId);
          } finally {
            session = await stripe.checkout.sessions.retrieve(sessionId);
            if (session.payment_status === 'paid') {
              await refund(human.quote, session.payment_intent, 'Checkout');
              session = undefined;
            }
          }
        }
      }
      if (session?.payment_status === 'paid') await refund(human.quote, session.payment_intent, 'Checkout');
    }
    await waitFor(async () => {
      const response = await fetch(checkoutUrl, { redirect: 'manual' });
      return response.status === 409 && (await response.json()).error === 'quote_already_paid';
    }, 60_000, 'The live Stripe webhook did not record the paid Checkout quote');
    console.log('Checkout: paid quote recorded by the live Stripe webhook.');
  }

  const results = await Promise.allSettled([monitorAgent(), monitorCheckout()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(result.reason.type ?? result.reason.message);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.type ?? error.message);
  process.exitCode = 1;
});
