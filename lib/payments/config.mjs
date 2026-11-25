import Stripe from 'stripe';

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
