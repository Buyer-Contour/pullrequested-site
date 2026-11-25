import { getStore } from '@netlify/blobs';
import { paymentConfig } from './config.mjs';
import { createPaymentHandlers } from './handlers.mjs';

export { paymentConfig };

export function netlifyPaymentHandler(name) {
  return async (request) => {
    try {
      if (name === 'page') {
        const config = paymentConfig(process.env, { allowMissingStripe: true });
        return createPaymentHandlers(config).page(request);
      }
      const { PAYMENTS_ORIGIN, QUOTE_SIGNING_SECRET } = process.env;
      const config = name === 'mpp'
        ? paymentConfig({ PAYMENTS_ORIGIN, QUOTE_SIGNING_SECRET }, { allowMissingStripe: true })
        : paymentConfig();
      const blobs = getStore({ name: config.testMode ? 'quote-payments-test' : 'quote-payments-live', consistency: 'strong' });
      let mppRail;
      if (name === 'mpp') {
        const { mppConfig, createMppRail, mppBlobsStore } = await import('./mpp.mjs');
        const mpp = mppConfig();
        if (mpp) {
          const network = mpp.testnet ? 'moderato' : 'tempo';
          const replay = getStore({ name: `quote-payments-mpp-${network}`, consistency: 'strong' });
          mppRail = createMppRail({ ...mpp, origin: config.origin, store: mppBlobsStore(replay) });
        }
      }
      const store = {
        get: (key) => blobs.get(key, { type: 'json' }),
        add: async (key, value) => (await blobs.setJSON(key, value, { onlyIfNew: true })).modified,
      };
      return createPaymentHandlers({ ...config, store, mppRail })[name](request);
    } catch {
      console.error('Quote payment configuration is unavailable');
      return Response.json({ error: 'payment_service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
