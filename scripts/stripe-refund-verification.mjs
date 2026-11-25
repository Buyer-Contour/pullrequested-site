import assert from 'node:assert/strict';
import { refundVerificationPayment } from '../lib/payments/live-verification.mjs';
import { readQuote } from '../lib/payments/quotes.mjs';
import { paymentConfig } from '../lib/payments/runtime.mjs';

const { stripe, testMode, signingSecret } = paymentConfig();
assert.ok(!testMode && process.argv.includes('--confirm-live-refund'), 'Use a live key and pass --confirm-live-refund');
const quote = readQuote(process.env.LIVE_VERIFICATION_QUOTE_TOKEN, signingSecret, { allowExpired: true });
const result = await refundVerificationPayment(stripe, quote, process.env.LIVE_VERIFICATION_PAYMENT_INTENT);
console.log(`Verification refund ${result.id}: ${result.status}`);
if (result.status !== 'succeeded') process.exitCode = 1;
