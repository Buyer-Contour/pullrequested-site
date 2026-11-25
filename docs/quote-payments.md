# Quote payments

The payment service charges only an agency-issued quote. Give a human the `quote_url` and an agent the `pay_url` from the same quote. The quote fixes the USD amount and expiry; customers cannot set the amount. The URLs are bearer links, not encrypted: do not put private information in the description or publish the links.

```sh
npm run payments:quote -- --amount-cents 500 --description 'Test consulting quote'
```

Quotes default to 23 hours (the maximum). To shorten one, add `--expires-in SECONDS`. A new Checkout session needs at least 31 minutes of remaining quote lifetime so its Stripe expiry does not exceed the quote expiry. Never reuse a quote ID; the script always generates a new one.

## Netlify and Stripe

1. Deploy this repository to the Netlify site that serves payments. Netlify runs the functions in `netlify/functions`; Netlify Blobs supplies site-scoped storage without a separate database. Surge continues to serve only static pages, so payment URLs always point at the Netlify host (or its configured custom domain).
2. In the Functions runtime environment, set `PAYMENTS_ORIGIN` to the canonical HTTPS origin and set `STRIPE_SECRET_KEY`, `QUOTE_SIGNING_SECRET` (at least 32 random bytes), and `STRIPE_WEBHOOK_SECRET` from Bot secrets. Use a Stripe test key to start. A restricted Stripe key needs Checkout Sessions read/write and PaymentIntents read/write. Keep test and live credentials in separate deploy environments; do not issue test quote URLs against a live payment service.
3. In Stripe, enable **Cards** and **Link** in Checkout's dynamic payment methods. Stripe displays Link only when the customer, currency, and Stripe account are eligible. Configure a webhook at `<PAYMENTS_ORIGIN>/api/stripe-webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Save that endpoint's signing secret. Only a valid Stripe webhook confirming payment records a human quote as paid; the success page is not proof of payment.
4. A live agent must have a Stripe Shared Payment Token (`spt_…`) scoped to the merchant and payment. The merchant also needs Stripe's Shared Payment Token preview access; the service does not offer raw card collection or charge against arbitrary stored Payment Method IDs. Verify preview access and a permitted agent issuer before advertising the live agent path.

The first valid payment attempt reserves its path for that quote. GETting a challenge or viewing the human quote does not reserve it; opening Stripe Checkout does. Retry interrupted agent POSTs using the same credential. To switch paths or replace a rejected credential, first check in Stripe that no payment succeeded; expire any open Checkout session before issuing a replacement quote. Do not edit or delete active reservations. Retry any pending settlement in Stripe before reissuing or changing payment configuration.

The service uses a per-quote Stripe idempotency key and limits quote validity to less than Stripe's minimum idempotency-key retention. A strongly consistent Netlify Blobs conditional create reserves the path before a charge and records the first valid receipt; Stripe metadata is only used to verify the quote binding, not as an atomic lock. Keep the same payment origin, Stripe account, signer, and Blobs store throughout a quote's lifetime. Blobs keep test and live state separate.

## Agent API

This is a custom HTTP 402 protocol, `quote-pay-v1`, not wire-compatible with x402 or MPP.

1. `GET /api/pay?quote=<signed-quote-token>` returns HTTP 402 with `quote_id`, `amount_cents`, `currency`, `expires_at`, and `nonce`.
2. `POST` to the same URL with JSON `{"nonce":"<nonce>","shared_payment_token":"<spt_…>"}`. A test-mode server also accepts `{"nonce":"<nonce>","payment_method":"pm_card_visa"}` for acceptance testing. HTTP 200 returns `payment_intent_id` after Stripe confirms the charge.
3. `GET` the same URL with `X-PAYMENT: <payment_intent_id>`. HTTP 200 returns the paid receipt. A matching succeeded intent, exact amount and currency, and bound quote and nonce are required. A replay returns HTTP 409, an unverified payment returns HTTP 402, and an expired quote cannot start a new payment (410).

The [offer.json fragment](offer-payments.fragment.json) and [llms.txt fragment](llms-payments.fragment.txt) are for the site owner to publish after verification. Use the deployed payment origin if it differs from the static site's origin. Do not add the quote-pay API to the native x402 discovery manifest.

## Verify in Stripe test mode

Run `npm ci` and `npm test` for automated coverage of signature and expiry, Checkout and webhook state, agent receipt verification, and concurrent replay rejection. For provider acceptance:

1. Set a test Stripe key, the quote signing secret, and the running service's `PAYMENTS_ORIGIN` in your shell using Bot secrets. For a local run, use `PAYMENTS_ORIGIN=http://127.0.0.1:8787`, set a test webhook signing secret, and run `npm run payments:dev` in another shell with the same values. The local server uses an ignored on-disk store and is not a production deployment.
2. Run `npm run payments:e2e` against the deployed test service, or `npm run payments:e2e -- --local-webhook` against the local server. It creates independent test quotes so each path can pay once, verifies the agent PaymentIntent and receipt, then checks that replay gets HTTP 409.
3. Open the printed Stripe Checkout URL, complete the test purchase with Stripe's 4242 test card, and wait for the script to verify the paid Checkout session and recorded quote. On the deployment, this also verifies Stripe-delivered webhook handling. The local flag delivers a locally signed event built from the actual paid Checkout session; it does not verify Stripe-to-Netlify delivery. Check Link separately in an eligible Stripe test Checkout.
