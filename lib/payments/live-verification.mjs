import assert from 'node:assert/strict';
import { makeQuote } from './quotes.mjs';
import { stripeSource } from './stripe-settings.mjs';

export const verificationAmount = 100;
export const agentVerificationDescription = 'Live verification (agent)';
export const checkoutVerificationDescription = 'Live verification (checkout)';

export function makeAgentVerificationQuote(signingSecret, now) {
  return makeQuote({
    amount_cents: verificationAmount, description: agentVerificationDescription, expiresIn: 15 * 60,
  }, signingSecret, now);
}

export async function refundVerificationPayment(stripe, quote, id) {
  assert.ok([agentVerificationDescription, checkoutVerificationDescription].includes(quote.description));
  assert.equal(quote.amount_cents, verificationAmount);
  assert.match(id, /^pi_[a-zA-Z0-9]+$/);
  const intent = await stripe.paymentIntents.retrieve(id);
  assert.equal(intent.livemode, true);
  assert.equal(intent.status, 'succeeded');
  assert.equal(intent.metadata.source, stripeSource);
  assert.equal(intent.metadata.quote_id, quote.id);
  assert.equal(intent.metadata.quote_fingerprint, quote.fingerprint);
  assert.equal(intent.amount_received, verificationAmount);
  assert.equal(intent.currency, 'usd');
  return stripe.refunds.create({ payment_intent: id, amount: verificationAmount }, { idempotencyKey: `live-verification-refund-${id}` });
}
