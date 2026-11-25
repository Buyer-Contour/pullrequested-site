import { paymentConfig } from '../lib/payments/config.mjs';

export function workerPaymentConfig(env, { mppOnly = false, allowMissingStripe = mppOnly } = {}) {
  const { PAYMENTS_ORIGIN, WORKER_QUOTE_SIGNING_SECRET, QUOTE_SIGNING_SECRET } = env;
  if (!WORKER_QUOTE_SIGNING_SECRET || WORKER_QUOTE_SIGNING_SECRET === QUOTE_SIGNING_SECRET) {
    throw new Error('Set WORKER_QUOTE_SIGNING_SECRET independently of the Netlify signer');
  }
  return paymentConfig({
    ...(mppOnly ? {} : env),
    PAYMENTS_ORIGIN,
    QUOTE_SIGNING_SECRET: WORKER_QUOTE_SIGNING_SECRET,
  }, { allowMissingStripe });
}
