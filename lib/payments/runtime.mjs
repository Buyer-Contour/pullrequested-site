import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';
import { createPaymentHandlers } from './handlers.mjs';

export function paymentConfig(env = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!/^(sk|rk)_(live|test)_/.test(key)) throw new Error('Set STRIPE_SECRET_KEY to a Stripe secret or restricted key');
  const origin = new URL(env.PAYMENTS_ORIGIN);
  if (origin.origin !== origin.href.slice(0, -1) ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
    throw new Error('Set PAYMENTS_ORIGIN to the canonical HTTPS origin (HTTP loopback is allowed for local tests)');
  }
  if (!env.QUOTE_SIGNING_SECRET || Buffer.byteLength(env.QUOTE_SIGNING_SECRET) < 32) {
    throw new Error('Set QUOTE_SIGNING_SECRET to at least 32 bytes');
  }
  const stripe = new Stripe(key, { maxNetworkRetries: 1, timeout: 8000 });
  return { stripe, origin, testMode: key.includes('_test_'), signingSecret: env.QUOTE_SIGNING_SECRET, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

export function netlifyPaymentHandler(name) {
  return async (request) => {
    try {
      const config = paymentConfig();
      const blobs = getStore({ name: config.testMode ? 'quote-payments-test' : 'quote-payments-live', consistency: 'strong' });
      const store = {
        get: (key) => blobs.get(key, { type: 'json' }),
        add: async (key, value) => (await blobs.setJSON(key, value, { onlyIfNew: true })).modified,
      };
      return createPaymentHandlers({ ...config, store })[name](request);
    } catch {
      console.error('Quote payment configuration is unavailable');
      return Response.json({ error: 'payment_service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
