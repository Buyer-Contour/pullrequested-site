import assert from 'node:assert/strict';
import { paymentConfig } from '../lib/payments/runtime.mjs';
import { checkoutWebhookEvents, stripeSource } from '../lib/payments/stripe-settings.mjs';

assert.ok(process.argv.includes('--confirm-create-live-webhook'), 'Pass --confirm-create-live-webhook to create the dedicated endpoint');
const { stripe, origin, testMode } = paymentConfig();
assert.ok(!testMode && origin.protocol === 'https:', 'Use a restricted live key and the deployed HTTPS origin');
const url = new URL('/api/stripe-webhook', origin).href;
const description = 'Phantom Pipe quote payments';
for await (const existing of stripe.webhookEndpoints.list({ limit: 100 })) {
  if (existing.url !== url) continue;
  assert.equal(existing.metadata.source, stripeSource, 'A different integration owns this webhook URL');
  assert.deepEqual([...existing.enabled_events].sort(), [...checkoutWebhookEvents].sort(), 'Review the existing webhook event filter');
  console.log(`Dedicated webhook already exists: ${existing.id}`);
  process.exit(0);
}
const webhook = await stripe.webhookEndpoints.create({
  url, description, enabled_events: checkoutWebhookEvents, metadata: { source: stripeSource },
}, { idempotencyKey: `pullrequested-stripe-webhook:${url}` });
console.log(`Created dedicated webhook ${webhook.id}. Reveal its signing secret in Stripe and store it in Bot secrets before configuring the function.`);
