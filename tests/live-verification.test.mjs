import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refundVerificationPayment, agentVerificationDescription } from '../lib/payments/live-verification.mjs';

test('refund helper only refunds the signed matching $1 live verification payment and uses a stable idempotency key', async () => {
  const quote = { id: 'quote-1', fingerprint: 'quote-fingerprint', amount_cents: 100, description: agentVerificationDescription };
  const payment = { livemode: true, status: 'succeeded', amount_received: 100, currency: 'usd',
    metadata: { source: 'pullrequested', quote_id: quote.id, quote_fingerprint: quote.fingerprint } };
  const calls = [];
  const stripe = {
    paymentIntents: { retrieve: async () => payment },
    refunds: { create: async (...args) => { calls.push(args); return { status: 'succeeded' }; } },
  };
  await assert.rejects(() => refundVerificationPayment(stripe, { ...quote, description: 'Customer quote' }, 'pi_fixture'));
  await assert.rejects(() => refundVerificationPayment(stripe, { ...quote, fingerprint: 'wrong-quote' }, 'pi_fixture'));
  payment.metadata.source = 'other-business';
  await assert.rejects(() => refundVerificationPayment(stripe, quote, 'pi_fixture'));
  payment.metadata.source = 'pullrequested';
  payment.livemode = false;
  await assert.rejects(() => refundVerificationPayment(stripe, quote, 'pi_fixture'));
  assert.equal(calls.length, 0);
  payment.livemode = true;
  assert.equal((await refundVerificationPayment(stripe, quote, 'pi_fixture')).status, 'succeeded');
  assert.deepEqual(calls, [[{ payment_intent: 'pi_fixture', amount: 100 }, { idempotencyKey: 'live-verification-refund-pi_fixture' }]]);
});
