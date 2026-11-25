import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';
import { createPaymentHandlers } from './handlers.mjs';

export function paymentConfig(env = process.env, { allowMissingStripe = false } = {}) {
  const key = env.STRIPE_LIVE_RESTRICTED_KEY || env.STRIPE_SECRET_KEY;
  if (env.STRIPE_LIVE_RESTRICTED_KEY && !/^rk_live_/.test(env.STRIPE_LIVE_RESTRICTED_KEY)) {
    throw new Error('STRIPE_LIVE_RESTRICTED_KEY must be a restricted live key');
  }
  if (!env.STRIPE_LIVE_RESTRICTED_KEY && (!allowMissingStripe || key) && !/^(sk|rk)_test_/.test(key)) {
    throw new Error('Live Stripe payments require STRIPE_LIVE_RESTRICTED_KEY');
  }
  const testMode = /^(sk|rk)_test_/.test(key);
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY;
  const publishableKeyMode = /^pk_(test|live)_[a-zA-Z0-9_]+$/.exec(publishableKey)?.[1];
  if (publishableKey && publishableKeyMode !== (testMode ? 'test' : 'live')) {
    throw new Error('STRIPE_PUBLISHABLE_KEY must be a Stripe publishable key in the same mode as the configured Stripe key');
  }
  const origin = new URL(env.PAYMENTS_ORIGIN);
  if (origin.origin !== origin.href.slice(0, -1) ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
    throw new Error('Set PAYMENTS_ORIGIN to the canonical HTTPS origin (HTTP loopback is allowed for local tests)');
  }
  if (!env.QUOTE_SIGNING_SECRET || Buffer.byteLength(env.QUOTE_SIGNING_SECRET) < 32) {
    throw new Error('Set QUOTE_SIGNING_SECRET to at least 32 bytes');
  }
  const stripe = key ? new Stripe(key, { maxNetworkRetries: 1, timeout: 8000 }) : undefined;
  return { stripe, origin, testMode, publishableKey, signingSecret: env.QUOTE_SIGNING_SECRET, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

export async function loadX402Rail(origin) {
  if (!process.env.X402_PAY_TO) return;
  const { x402Config, createX402Rail } = await import('./x402.mjs');
  return createX402Rail({ ...x402Config(), origin });
}

export function netlifyPaymentHandler(name) {
  let x402Rail;
  return async (request) => {
    try {
      const config = paymentConfig(process.env, { allowMissingStripe: name === 'x402' });
      if (name === 'x402') x402Rail ??= await loadX402Rail(config.origin);
      const blobs = getStore({ name: config.testMode ? 'quote-payments-test' : 'quote-payments-live', consistency: 'strong' });
      const store = {
        get: (key) => blobs.get(key, { type: 'json' }),
        add: async (key, value) => (await blobs.setJSON(key, value, { onlyIfNew: true })).modified,
      };
      return createPaymentHandlers({ ...config, store, x402Rail })[name](request);
    } catch {
      console.error('Quote payment configuration is unavailable');
      return Response.json({ error: 'payment_service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
