import { DurableObject } from 'cloudflare:workers';
import { variantOf } from '../lib/variants.mjs';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { createMppRail, mppConfig, mppPath } from '../lib/payments/mpp.mjs';
import { workerPaymentConfig } from './payment-config.mjs';
import { paymentState, paymentStores } from './payment-state.mjs';
import { recordVariant, variantStats } from './variant-stats.mjs';

export class PaymentsState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = paymentState(ctx.storage);
    this.storage = ctx.storage;
  }

  read(key) { return this.state.read(key); }
  write(key, value) { this.state.write(key, value); }
  remove(key) { this.state.remove(key); }
  compareAndSet(key, expectedVersion, value, remove) {
    return this.state.compareAndSet(key, expectedVersion, value, remove);
  }
  incrementVariant(event, variant) {
    this.variants ??= variantStats(this.storage.sql);
    this.variants.increment(event, variant);
  }
  listVariants() {
    this.variants ??= variantStats(this.storage.sql);
    return this.variants.list();
  }
}

const routes = new Map([
  ['/api/checkout', 'checkout'],
  ['/api/pay', 'pay'],
  ['/api/stripe-webhook', 'webhook'],
  ['/agent-pay-test', 'agentVerification'],
  [mppPath, 'mpp'],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let name = routes.get(url.pathname);
    if (url.pathname.startsWith('/q/')) {
      name = 'page';
      const variant = url.searchParams.has('v') ? variantOf(url) : null;
      url.search = '';
      url.searchParams.set('quote', url.pathname.slice(3));
      if (variant !== null) url.searchParams.set('v', variant);
    } else if (url.pathname === '/payment/submitted') {
      name = 'page';
      url.searchParams.set('result', 'submitted');
    }
    if (!name) return new Response('Not found', { status: 404 });

    try {
      const track = (event, source) => recordVariant(env, event, source);
      const routedRequest = url.href === request.url ? request : new Request(url, request);
      if (name === 'page') {
        const config = workerPaymentConfig(env, { allowMissingStripe: true });
        return createPaymentHandlers({ ...config, recordVariant: track }).page(routedRequest);
      }
      const config = workerPaymentConfig(env, { mppOnly: name === 'mpp' });
      const quoteState = env.PAYMENTS_STATE.getByName(config.testMode ? 'quotes-test' : 'quotes-live');
      const mpp = name === 'mpp' && mppConfig(env);
      const mppRail = mpp ? createMppRail({
        ...mpp,
        origin: config.origin,
        store: paymentStores(env.PAYMENTS_STATE.getByName(mpp.testnet ? 'mpp-moderato' : 'mpp-tempo')).mpp,
      }) : undefined;
      const handler = createPaymentHandlers({ ...config, store: paymentStores(quoteState).quotes, mppRail, recordVariant: track })[name];
      return handler(routedRequest);
    } catch {
      console.error('Quote payment configuration is unavailable');
      return Response.json({ error: 'payment_service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
