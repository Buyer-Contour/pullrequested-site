# Quote payments

## Tempo MPP

The independent `GET /api/mpp/pay?quote=<signed_quote_token>` rail uses `mppx` to issue a Tempo charge and verify settlement directly on-chain. Stripe keys, CDP, and facilitators are not required.

For production, set `MPP_NETWORK=tempo` and `MPP_PAY_TO=0xD95C1942dce3c8622AcdB0436B4BC9e93B3E0765`. For testnet, set `MPP_NETWORK=moderato` and use the intended test recipient. Set `MPP_SECRET_KEY` to its own secret of at least 32 random bytes, and set `PAYMENTS_ORIGIN` and `QUOTE_SIGNING_SECRET`. The service does not need the receiving wallet's private key. Moderato receipts cannot mark a live quote paid.

Use OUSD on the selected network. The payer pays the network fees; this route does not sponsor fees or advertise MACH funding. Run `tempo request --dry-run '<MPP quote URL>'` before paying, then `tempo request --max-spend <quote amount> '<MPP quote URL>'`. Use pull mode to let the server reserve the quote before broadcasting. In push mode, do not start another rail after taking an MPP challenge: an already-broadcast transfer cannot be canceled by a quote reservation. Reconcile an uncertain payment before issuing another one.

## Issue a quote

The payment service charges only an agency-issued quote. Give a human the `quote_url` and an agent the `mpp_url` for Tempo or the `pay_url` for Stripe, from the same quote. The quote fixes the USD amount and expiry; customers cannot set the amount. The URLs are bearer links, not encrypted: do not put private information in the description or publish the links.

```sh
npm run payments:quote -- --amount-cents 500 --description 'Test consulting quote'
```

Quotes default to 23 hours (the maximum). To shorten one, add `--expires-in SECONDS`. A new Checkout session needs at least 31 minutes of remaining quote lifetime so its Stripe expiry does not exceed the quote expiry. Never reuse a quote ID; the script always generates a new one.

## Netlify and Stripe

1. Deploy this repository to the Netlify site that serves payments. Netlify runs the functions in `netlify/functions`; Netlify Blobs supplies site-scoped storage without a separate database. Surge continues to serve only static pages, so payment URLs always point at the Netlify host (or its configured custom domain).
2. In the Functions runtime environment, set `PAYMENTS_ORIGIN` to `https://phantompipe.com`. Use only the dedicated `STRIPE_LIVE_RESTRICTED_KEY` and set `QUOTE_SIGNING_SECRET` (at least 32 random bytes) from Bot secrets. Set `STRIPE_PUBLISHABLE_KEY` from the same Stripe account and live mode; this public key is advertised in the 402 challenge. Required restricted permissions: Checkout Sessions read/write, PaymentIntents read/write, PaymentMethods read, and Charges and Refunds write for verification refunds. Creating the dedicated webhook from the CLI also needs Webhook Endpoints read/write; its runtime only needs the signing secret.
3. Verify **Cards** and **Link** are available in Checkout's dynamic payment methods without changing settings for other integrations. Stripe displays Link only when the customer, currency, and Stripe account are eligible. Create a dedicated Stripe webhook at `<PAYMENTS_ORIGIN>/api/stripe-webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. With webhook management permissions, run `npm run payments:create-webhook -- --confirm-create-live-webhook` or create it in the Stripe Dashboard. Reveal this endpoint's signing secret, save it in Bot secrets, and bind it as `STRIPE_WEBHOOK_SECRET`; never reuse a signing secret from another endpoint. Checkout sessions and PaymentIntents carry `source=pullrequested`, and the webhook ignores other integrations' events even if validly signed.
4. Agent card payments do not require preview access. The optional Shared Payment Token path requires Stripe preview access and a permitted agent issuer; the token must be scoped to the merchant and payment. The quote service never accepts raw card details or cards attached to a Stripe customer.

The first valid payment attempt reserves its path for that quote. GETting a challenge or viewing the human quote does not reserve it; opening Stripe Checkout does. Retry interrupted agent POSTs using the same credential. To switch paths or replace a rejected credential, first check in Stripe that no payment succeeded; expire any open Checkout session before issuing a replacement quote. Do not edit or delete active reservations. Retry any pending settlement in Stripe before reissuing or changing payment configuration.

The service uses a per-quote Stripe idempotency key and limits quote validity to less than Stripe's minimum idempotency-key retention. An atomic conditional create reserves the path before a charge and records the first valid receipt; Stripe metadata is only used to verify the quote binding, not as an atomic lock. Keep the same payment origin, Stripe account, signer, and state store throughout a quote's lifetime. Test and live state are separate.

## Cloudflare Workers fallback

Deploy with Wrangler using the repository's `wrangler.toml`. The payment Worker uses SQLite-backed Durable Objects on Workers Free. It serves payment routes only; the static site and quote intake stay on Netlify.

- Use the assigned `https://phantompipe-payments.<subdomain>.workers.dev` URL as `PAYMENTS_ORIGIN` unless Cloudflare serves the site's DNS. Set the same Stripe and Tempo settings described above via Workers secrets or environment bindings. Use the Worker origin in the quote generator and the dedicated Stripe webhook URL.
- Netlify Blobs records are not shared with the Worker. Before switching hosts, resolve in-flight payments on Netlify, stop issuing there, and issue fresh quote IDs for the Worker. Update the static site's payment discovery URLs when its next deployment is available.

## Agent API

This is a custom HTTP 402 protocol, `quote-pay-v1`, not wire-compatible with x402 or MPP.

1. `GET /api/pay?quote=<signed-quote-token>` returns HTTP 402 with `quote_id`, `amount_cents`, `currency`, `expires_at`, and `nonce`. When agent card tokenization is enabled, `payment.stripe.publishable_key` and `payment.stripe.tokenize` tell the client how to create a card PaymentMethod.
2. For a card payment, initialize [Stripe.js](https://docs.stripe.com/js/payment_methods/create_payment_method) with the advertised key, collect card details in Stripe's Card Element, and call `stripe.createPaymentMethod({ type: 'card', card: cardElement })`. On success, `POST` JSON `{"nonce":"<nonce>","payment_method":"<pm_…>"}` to the same quote URL using the returned ID. Use a card PaymentMethod created for this quote after issuance, and do not attach it to a customer. Test mode also accepts `pm_card_visa` without tokenization.
3. To pay with a Shared Payment Token instead, send `{"nonce":"<nonce>","shared_payment_token":"<spt_…>"}`. Send exactly one credential field. Either path returns HTTP 200 with `payment_intent_id` only after Stripe confirms the charge. A card that needs additional authentication cannot be completed by this agent endpoint; contact the agency for a replacement quote payable through Checkout.
4. `GET` the same URL with `X-PAYMENT: <payment_intent_id>`. HTTP 200 returns the paid receipt. A matching succeeded intent, exact amount and currency, and bound quote and nonce are required. A replay returns HTTP 409, an unverified payment returns HTTP 402, and an expired quote cannot start a new payment (410).

The [offer.json fragment](offer-payments.fragment.json) and [llms.txt fragment](llms-payments.fragment.txt) are for the site owner to publish after verification. Use the deployed payment origin if it differs from the static site's origin.

## Verify in Stripe live mode

Run `npm ci` and `npm test` for automated coverage. For authorized provider acceptance, use the deployed HTTPS service and live Stripe credentials only:

1. With the dedicated restricted live key, matching publishable key, canonical origin, and quote-signing secret configured, run `npm run payments:e2e:live -- --confirm-two-live-payments` after approval. It opens two independent $1 quotes and prints two private links: the hosted Stripe Checkout URL and a dedicated agent verification page. Give only those links to the authorized payer. The agent page collects the card with Stripe Elements, then submits only the PaymentMethod ID and nonce to the agent endpoint; it verifies that redemption succeeds and that a replay returns 409. Do not store or ask for card details.
2. Keep the monitoring command running while the payer completes both flows. The agent link expires after 15 minutes, and monitoring continues for two more minutes to allow for Stripe search indexing. Verification Checkout is limited to eligible cards and Link, and the command expires the session if it is still open at the end of its monitoring window. The command refunds each matching $1 payment as soon as it is observed, verifies the Checkout webhook and checks the agent replay again. If interrupted, use the quote ID printed in the output to find the charge in Stripe. A refund may take time to succeed and Stripe may retain processing fees; record any net spend in the spend ledger.
3. If a response is lost or the script is interrupted, locate the charge by its quote ID in Stripe before retrying; do not issue a second quote blindly. Use the Dashboard to refund it, or set `LIVE_VERIFICATION_QUOTE_TOKEN` and `LIVE_VERIFICATION_PAYMENT_INTENT` and run `npm run payments:refund-verification -- --confirm-live-refund`. The helper only refunds the matching signed $1 verification quote. Confirm each refund succeeded before signing off.
