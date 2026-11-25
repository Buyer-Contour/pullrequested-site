# Phantom Pipe

Static go-to-market consulting site for Phantom Pipe at [phantompipe.com](https://phantompipe.com/), with Netlify Functions for quote payments.

## Structure

- `public/index.html`: Landing page and services.
- `public/quote/index.html`, `public/thanks/index.html`: Quote form and confirmation page.
- `public/offer.json`, `public/llms.txt`: Offer and submission instructions for agents.
- `public/.well-known/x402.json`: Legacy discovery manifest pointing only to free resources; no x402 payment rail is offered.
- `public/robots.txt`, `public/sitemap.xml`: Crawler metadata.
- `scripts/build-surge.js`: Builds a standalone Surge copy for interim hosting.
- `netlify.toml`: Publish directory, route rewrite, and response headers.
- `netlify/functions/`: Signed quote pages, Stripe Checkout, Tempo MPP and Stripe agent payments, and the Stripe webhook. See the [quote payment guide](docs/quote-payments.md).
- `SPEND_LEDGER.md`: Budget and recorded spend.

## Local development

Run `npm ci` and `npm test` with Node.js 22. To preview the static site, run `python3 -m http.server 8080 --directory public` and open [http://localhost:8080](http://localhost:8080). The static server does not process forms, apply Netlify headers, or run payment functions. See the payment guide for a local payment server.

## Deploy the site to Cloudflare

The `phantompipe-site` Worker serves `public/`. Browser quote submissions still go to the existing Netlify Forms deployment (`phantompipe.netlify.app`), which also receives API submissions as form data with a request ID appended to the brief. POST JSON or request a JSON response on `/quote` to get a receipt. The site's `QuoteReceipts` Durable Object stores receipts for 30 days with no submission fields; status reads do not query Netlify. The legacy `/agent-pay-test` page also keeps the Netlify origin. The live payment routes remain on a separate Worker.

Deploy from the repository root with Wrangler 4 and the zone's deploy credentials:

```sh
npx wrangler@4 deploy --config wrangler.site.toml
```

Keep the more specific apex payment routes on the separate `phantompipe-payments` Worker (see [quote payments](docs/quote-payments.md)). Do not change its secret bindings or Durable Object. Compare browser and agent submission responses and payment responses before and after any routing change. Both the apex and `www` need proxied DNS records. The site Worker redirects `www` to the apex with HTTP 308, preserving the path, query, and request method.

### Pitch variant counts

Give each pitch a short, non-personal variant ID using lowercase letters, digits, and hyphens (1–40 characters). Example links for `media-1`:

- Homepage and discovery: `/?v=media-1`, `/offer.json?v=media-1`, `/llms.txt?v=media-1`.
- Payments: `/q/evidence-brief-10?v=media-1`, `/api/mpp/pay?product=evidence-brief-10&v=media-1`. Follow redirects without dropping their query string.
- Quote intake: link to `/quote?v=media-1`, or POST directly to it for agent requests. The tagged homepage and browser form preserve the tag for submissions.

`GET /api/stats/variants` on the site Worker returns `{ "counts": [{ "day": "YYYY-MM-DD", "event": "card_open", "variant": "media-1", "count": 1 }] }` with UTC daily totals. Discovery events count successful tagged GETs only. Payment events count durable card opens and issued MPP challenges, not completed payments. Intake counts requests accepted by the forwarding endpoint, not verified inbox delivery. Missing or invalid tags on payment or intake, and invalid tags on discovery, count as `untagged`. Only the event, day, normalized variant, and count are stored. Repeat fetches, previews and bots can count; these are not unique visitors or proof of intent.

Deploy `wrangler.toml` before `wrangler.site.toml` for changes to variant counters: the site Worker uses the payment Worker's existing Durable Object namespace.

## Interim Surge deploy

1. Build the Surge copy: `SURGE_SITE_URL=https://pullrequested.surge.sh npm run build:surge`. The quote form sends to the public, inbound-only agency inbox, `dane@phantompipe.com`, by default. If setting `QUOTE_RECIPIENT` for a different deployment, use only a public inbox address; it appears in the form and agent endpoint.
2. Publish `dist/surge` to the same Surge hostname using the agency account. Set the account credential through Bot secrets, not in the repo.
3. Submit a clearly marked request on `/quote/` to trigger FormSubmit registration. Open the activation email in the agency inbox and verify its source before activating. Submit another browser request and a JSON request using `/offer.json`; confirm both arrive in the inbox. An HTTP success response alone does not verify delivery.
4. Verify `/`, `/quote/`, `/offer.json`, `/llms.txt`, `/.well-known/x402.json`, and `/thanks/` on the actual Surge URL. The temporary copy links to itself in the agent docs and sitemap; HTML canonicals and the offer's main URL still identify `phantompipe.com`.

## Legacy Netlify deployment

The [`phantompipe` Netlify site](https://app.netlify.com/sites/phantompipe/overview) (site ID `abbb33f1-2767-44fe-84fc-460233cc6a64`) remains the quote intake backend. If maintaining that deployment, publish `public/`, not `dist/surge`, to keep both quote paths on Netlify Forms.

1. For a manual production deploy, run from the repository root after `npm ci` and bind `NETLIFY_AUTH_TOKEN` from Bot secrets. Pass the site ID explicitly so a stale local site link cannot select the retired site. `netlify.toml` supplies the publish directory, functions, redirects, and headers.

   ```sh
   npx netlify-cli deploy --prod --site abbb33f1-2767-44fe-84fc-460233cc6a64
   ```

2. Confirm form detection is enabled and the site's **Forms** page lists `quote` after deployment. Submissions are stored in the Forms dashboard; configure email notifications for the `quote` form to `dane@phantompipe.com`.
3. On [phantompipe.netlify.app](https://phantompipe.netlify.app/), open `/`, `/quote`, `/offer.json`, and `/llms.txt`. Submit a clearly marked test from the browser, confirm the thank-you page and a dashboard entry, then verify the agent POST independently:

   ```sh
   curl --fail-with-body -sS -o /dev/null -w 'HTTP %{http_code}\n' \
     --data-urlencode 'form-name=quote' \
     --data-urlencode 'name=Deployment test' \
     --data-urlencode 'email=test@example.com' \
     --data-urlencode 'service=not-sure' \
     --data-urlencode 'brief=Deployment smoke test; please ignore.' \
     https://phantompipe.netlify.app/quote
   ```

   Check the stored submission in the dashboard; an HTTP success response alone is not proof of delivery. Confirm the JSON content type and wildcard CORS header on `/offer.json` and the plain-text content type on `/llms.txt`.
4. Verify the deploy on [phantompipe.com](https://phantompipe.com/), including HTTPS and the quote form. Repeat the curl smoke test at the apex with `-H 'Accept: application/json'` and print the body. Expect HTTP 202, then GET the returned `status_url` and expect HTTP 200. Confirm the matching request ID appears in the dashboard submission.

Keep hosting credentials in Bot secrets, not in the repository.
