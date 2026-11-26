# Pricing Page Change Monitor

Track public competitor pricing without checking the same pages by hand. Phantom Pipe, an AI GTM agent, built this tool for competitive intelligence, sales enablement, and product marketing. Schedule it in Apify to establish a baseline, then send rows with `changed: true` to your reporting or alerting workflow.

## Input

```json
{
  "urls": ["https://linear.app/pricing", "https://www.notion.com/pricing"],
  "keywords": ["annual contract", "minimum seats"]
}
```

- **`urls`**: 1–100 public page URLs. Exact duplicates are checked once.
- **`keywords`**: optional literal, case-insensitive terms. Use the same list across runs so your baseline is comparable.
- **`previousSnapshots`**: optional object keyed by the exact URL in `urls`. A value may contain `contentHash`, `pricingText`, or both. An explicit entry overrides that URL's most recent successful saved snapshot in the Actor's named `pricing-monitor-state` store.

## Output

Each checked URL returns a dataset row. Example (illustrative values):

```json
{
  "url": "https://example.com/pricing",
  "checkedAt": "2026-11-25T09:30:00.000Z",
  "title": "Example pricing",
  "prices": ["$12"],
  "planNames": ["Pro"],
  "pricingText": "Pro\n$12 per seat",
  "contentHash": "4c55c694b4f50c2aa6453ba0fdd1390dedc6dfdcc7e092f385c99c9c42933cd4",
  "changed": true,
  "addedLines": ["$12 per seat"],
  "removedLines": ["$10 per seat"]
}
```

The first successful check establishes a baseline and reports `changed: false`. A hash-only baseline detects change but cannot show which lines changed. Failed checks return an `error` without replacing the saved snapshot. Extraction is based on server-rendered HTML and looks for USD, EUR, and GBP amounts, billing terms, likely plan headings, and your keywords. It doesn't execute JavaScript, sign in, or bypass CAPTCHAs. Regional prices, page tests, and HTML order can affect snapshots.

## Pricing

**$0.01 per successfully checked page** when the Actor is published with pay-per-event pricing. Failed fetches aren't billed. To configure monetization, create only the `page-checked` event at $0.01 per event; don't add a separate dataset-item charge.

## Run locally

Use Node.js 20.18.1 or higher, or run the included Actor Dockerfile on Apify.

```sh
npm ci
mkdir -p storage/key_value_stores/default
```

Save the input example as `storage/key_value_stores/default/INPUT.json`, then run:

```sh
APIFY_LOCAL_STORAGE_DIR=./storage node src/main.js
npm test
```

Results are written to `storage/datasets/default`. Use a separate storage directory for unrelated local runs.

## RapidAPI provider setup

The Cloudflare Worker exposes `GET /health` and `POST /v1/check`. The API does not save snapshots: send the previous response's `contentHash` as `previousHash`, and optionally its `pricingText` as `previousText` for line changes.

```sh
cd api
npx wrangler@4 dev
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/check -H 'Content-Type: application/json' \
  -d '{"url":"https://linear.app/pricing"}'
```

Wrangler 4 requires Node.js 22.12 or higher. Before publishing on RapidAPI, configure its proxy to use the same `RAPIDAPI_PROXY_SECRET` as the Worker. Keep the strict public egress flag enabled, don't attach private upstream access, and don't expose the local development server. Import [`api/openapi.json`](api/openapi.json) into RapidAPI; it already points to the deployed Worker.

Support: [dane@phantompipe.com](mailto:dane@phantompipe.com).
