# Furrow

Static go-to-market consulting site for `furrowgtm.com`. There are no app dependencies or build steps.

## Structure

- `public/index.html`: Landing page and services.
- `public/quote/index.html`, `public/thanks/index.html`: Quote form and confirmation page.
- `public/offer.json`, `public/llms.txt`: Offer and submission instructions for agents.
- `public/robots.txt`, `public/sitemap.xml`: Crawler metadata.
- `netlify.toml`: Publish directory, route rewrite, and response headers.
- `SPEND_LEDGER.md`: Budget and recorded spend.

## Local development

Run `npm test` with Node.js 22 (no install required). To preview the site, run `python3 -m http.server 8080 --directory public` and open [http://localhost:8080](http://localhost:8080). The local server redirects `/quote` to `/quote/` and does not process forms or apply Netlify headers.

## Deploy to Netlify

1. Create or import a site on the Free plan. When deploying from Git, leave the build command blank and publish `public/`; the repository's `netlify.toml` configures that directory. For a manual CLI deploy, run from the repository root so Netlify picks up the configuration.
2. Open the site's **Forms** page, enable form detection, and redeploy. Confirm that a form called `quote` is listed. Submissions are stored in the Forms dashboard; the agency does not need an inbox or notification address to collect them.
3. On the site's `*.netlify.app` URL, open `/`, `/quote`, `/offer.json`, and `/llms.txt`. Submit a clearly marked test from the browser, confirm the thank-you page and a dashboard entry, then verify the agent POST independently. For example, replace `YOUR-SITE` with the actual site name:

   ```sh
   curl --fail-with-body -sS -o /dev/null -w 'HTTP %{http_code}\n' \
     --data-urlencode 'form-name=quote' \
     --data-urlencode 'name=Deployment test' \
     --data-urlencode 'email=test@example.com' \
     --data-urlencode 'service=not-sure' \
     --data-urlencode 'brief=Deployment smoke test; please ignore.' \
     https://YOUR-SITE.netlify.app/quote
   ```

   Check the stored submission in the dashboard; an HTTP success response alone is not proof of delivery. Confirm the JSON content type and wildcard CORS header on `/offer.json` and the plain-text content type on `/llms.txt`.
4. In Netlify's domain settings, add `furrowgtm.com` as the primary domain and confirm `www.furrowgtm.com` is listed. For external DNS on the standard Netlify edge, use an apex ALIAS/ANAME (or flattened CNAME) to `apex-loadbalancer.netlify.com`, or an apex A record to `75.2.60.5` if the provider doesn't support those record types. Use a `www` CNAME to the assigned `YOUR-SITE.netlify.app` hostname. Confirm the exact values in Netlify's domain panel before sharing them, then verify HTTPS and the form on the custom domain. See [Netlify's external DNS guide](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/).

Keep hosting credentials in Bot secrets, not in the repository.
