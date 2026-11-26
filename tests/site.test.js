const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSurge } = require('../scripts/build-surge');

const read = (path) => readFileSync(resolve(__dirname, '..', path), 'utf8');

test('all public assets exist and are nonempty', () => {
  for (const path of [
    'index.html', 'quote/index.html', 'services/index.html', 'agent-bill-audit/index.html', 'scraper-parser/index.html',
    'thanks/index.html', 'styles.css', 'favicon.svg',
    'fonts/newsreader-roman.woff2', 'fonts/newsreader-italic.woff2', 'fonts/OFL-Newsreader.txt',
    'offer.json', 'ledger.json', 'llms.txt', 'robots.txt', 'sitemap.xml',
    '.well-known/x402.json',
  ]) {
    assert.ok(read(`public/${path}`).trim(), path);
  }
});

test('public assets and payment fragments use the Phantom Pipe brand', () => {
  for (const path of [
    'public/index.html', 'public/quote/index.html', 'public/services/index.html', 'public/agent-bill-audit/index.html',
    'public/scraper-parser/index.html', 'public/thanks/index.html',
    'public/offer.json', 'public/llms.txt', 'public/.well-known/x402.json',
    'public/robots.txt', 'public/sitemap.xml',
    'docs/offer-payments.fragment.json', 'docs/llms-payments.fragment.txt',
  ]) {
    assert.doesNotMatch(read(path), /pullrequested/i, path);
  }
  for (const path of ['index.html', 'quote/index.html', 'services/index.html', 'agent-bill-audit/index.html', 'scraper-parser/index.html', 'thanks/index.html']) {
    assert.match(read(`public/${path}`), /aria-label="Phantom Pipe home"/, path);
    assert.doesNotMatch(read(`public/${path}`), /\b(?:Clay|Matthew)\b/i, path);
  }
  assert.match(read('public/llms.txt'), /^# Phantom Pipe\n/);
  assert.ok(read('public/robots.txt').includes('Sitemap: https://phantompipe.com/sitemap.xml'));
  assert.ok(read('public/sitemap.xml').includes('<loc>https://phantompipe.com/quote</loc>'));
});

test('the fixed-price catalog and agent discovery agree with the Stripe Checkout products', async () => {
  const { microserviceFor } = await import('../lib/payments/quotes.mjs');
  const { fixed_price_services: catalog } = JSON.parse(read('public/offer.json'));
  const services = read('public/services/index.html');
  const llms = read('public/llms.txt');
  assert.equal(catalog.url, 'https://phantompipe.com/services/');
  assert.match(read('public/index.html'), /<nav[^>]*>.*href="\/services\/">Fixed-price services/);
  assert.ok(read('public/sitemap.xml').includes(`<loc>${catalog.url}</loc>`));
  assert.equal(catalog.services.length, 7);
  assert.equal(catalog.delivery_hours_from_brief, 48);
  assert.equal(catalog.revisions_included, 1);
  assert.equal(catalog.refund_if_not_delivered, true);
  for (const { id, name, price, deliverable, pay_url, page_url, forward_to_human } of catalog.services) {
    const displayName = name.replaceAll('&', '&amp;');
    const displayPrice = '$' + price.amount_minor / 100;
    assert.deepEqual(microserviceFor(id), { amount_cents: price.amount_minor, description: name });
    assert.equal(price.currency, 'USD');
    assert.equal(pay_url, `https://phantompipe.com/q/${id}?v=svc-${id}`);
    assert.ok(services.includes(`<h3>${displayName}</h3>`));
    assert.ok(services.includes(deliverable));
    assert.ok(services.includes(`href="${pay_url}"`));
    assert.ok(llms.includes(`[${name}](${pay_url}) — ${displayPrice} USD. ${deliverable}`));
    if (page_url) {
      const pagePath = new URL(page_url).pathname;
      const pageHtml = read(`public${pagePath}index.html`);
      assert.ok(read('public/sitemap.xml').includes(`<loc>${page_url}</loc>`));
      assert.ok(pageHtml.includes(`rel="canonical" href="${page_url}"`));
      assert.ok(pageHtml.includes(`href="${pay_url}"`));
      assert.ok(pageHtml.includes(forward_to_human.replaceAll('&', '&amp;')));
      assert.ok(llms.includes(`(${page_url})`));
    }
  }
});

test('offer and agent instructions match the Netlify form', () => {
  const offer = JSON.parse(read('public/offer.json'));
  const { url, method, content_type, fields } = offer.quote_request;
  const quote = read('public/quote/index.html');
  const llms = read('public/llms.txt');

  assert.equal(offer.name, 'Phantom Pipe');
  assert.equal(offer.url, 'https://phantompipe.com/');
  assert.equal(offer.contact.url, url);
  assert.equal(new URL(url).origin, new URL(offer.url).origin);
  assert.equal(new URL(url).pathname, '/quote');
  assert.equal(method, 'POST');
  assert.equal(content_type, 'application/x-www-form-urlencoded');
  assert.match(quote, /<form[^>]*name="quote"[^>]*method="POST"[^>]*action="\/thanks\/"[^>]*data-netlify="true"[^>]*netlify-honeypot="bot-field"/);
  assert.ok(quote.includes(`name="form-name" value="${fields['form-name'].const}"`));
  assert.match(quote, /<input name="bot-field"/);

  for (const [name, field] of Object.entries(fields)) {
    const control = quote.match(new RegExp(`<(?:input|select|textarea)[^>]* name="${name}"[^>]*>`));
    assert.ok(control, name);
    if (name !== 'form-name') assert.equal(/\brequired\b/.test(control[0]), field.required, name);
  }

  const options = [...quote.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, fields.service.enum);
  assert.deepEqual(options.filter((id) => id !== 'not-sure'), offer.services.map(({ id }) => id));
  assert.ok(llms.includes(`(${url})`));
  assert.ok(llms.includes(`(${new URL('/offer.json', offer.url).href})`));
  assert.ok(llms.includes(`POST to ${url}`));
  assert.ok(llms.includes(`form-name=${fields['form-name'].const}`));
});

test('each service publishes a free five-account CSV and a gap-first receipt', () => {
  const { services, per_row_pricing: pricing, row_acceptance: terms } = JSON.parse(read('public/offer.json'));
  for (const { sample } of services) {
    assert.equal(sample.price.amount_minor, 0);
    assert.equal(sample.receipt.format, 'gap-first-v1');
    assert.equal(Object.keys(sample.receipt)[1], 'gaps');
    assert.ok(sample.receipt.gaps.length);
    assert.equal(sample.receipt.rows_delivered, 5);
    assert.equal(sample.accounts.length, 5);
    assert.equal(new Set(sample.accounts.map(({ account_id }) => account_id)).size, 5);
    for (const { claim, source_url, source_date } of sample.accounts) {
      assert.ok(claim);
      assert.equal(new URL(source_url).protocol, 'https:');
      assert.match(source_date, /^\d{4}-\d{2}-\d{2}$/);
    }
    const columns = Object.keys(sample.accounts[0]);
    const escape = (cell) => /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell;
    assert.equal(read('public' + sample.csv_url).trim(), [
      columns.join(','),
      ...sample.accounts.map((row) => columns.map((column) => escape(row[column])).join(',')),
    ].join('\n'));
  }
  assert.equal(pricing.unit, 'accepted_account_row');
  assert.equal(pricing.example.max_amount_minor, pricing.amount_minor_per_row * pricing.example.row_count);
  assert.equal(terms.checked_by, 'buyer');
  assert.equal(terms.review_window_hours, 72);
  assert.match(terms.missing_or_rejected_row, /refund/);
  const llms = read('public/llms.txt');
  assert.ok(llms.includes(`$${pricing.amount_minor_per_row / 100} USD per accepted row`));
  assert.ok(llms.includes(`${terms.review_window_hours} hours after delivery`));
});

test('the research site keeps human and agent entry points discoverable', () => {
  const home = read('public/index.html');
  const { description } = JSON.parse(read('public/offer.json'));
  const llms = read('public/llms.txt');

  for (const source of [home, description, llms]) {
    assert.match(source, /experimental go-to-market agent/i);
    assert.match(source, /people and other agents/i);
    assert.doesNotMatch(source, /\b(?:Clay|Matthew)\b/i);
  }
  assert.match(home, /rel="canonical" href="https:\/\/phantompipe\.com\/"/);
  assert.match(home, /href="\/quote">Send a project brief/);
  assert.match(home, /href="\/offer\.json">offer\.json/);
  assert.match(home, /href="\/llms\.txt"/);
  assert.match(home, /<h2 id="research-heading">Working notes<\/h2>/);
  assert.equal([...home.matchAll(/<article class="note">/g)].length, 3);
});

test('the evidence brief publishes its sample, buyer checks and post-acceptance price', () => {
  const { evidence_brief: brief, quote_request: intake, per_row_pricing } = JSON.parse(read('public/offer.json'));
  const llms = read('public/llms.txt');
  const home = read('public/index.html');
  const { price, sample, request, acceptance, payment, receipt_schema: receipt } = brief;

  assert.deepEqual(price, { unit: 'accepted_account_row', currency: 'USD', amount_minor_per_row: 5 });
  assert.deepEqual(sample, { row_count: 3, amount_minor: 0, currency: 'USD', counts_toward_paid_rows: false });
  assert.ok(intake.fields.service.enum.includes(request.service));
  assert.match(request.before_work, /agree in writing.*maximum total/);
  assert.match(per_row_pricing.applies_to, /evidence brief uses its own pricing and acceptance terms/);
  assert.equal(acceptance.checked_by, 'buyer_or_buyer_agent');
  assert.equal(acceptance.max_trigger_age_days, 90);
  assert.equal(acceptance.review_window_hours, 48);
  assert.match(acceptance.silence_default, /no rejection.*accepted/);
  assert.equal(acceptance.cure_window_hours, 24);
  assert.equal(payment.model, 'pay_per_accepted_row');
  assert.equal(payment.rail, 'tempo_mpp');
  assert.equal(payment.quote_granularity, 'one_per_accepted_paid_row');
  assert.match(payment.funds_holder, /^The buyer holds all funds/);
  assert.match(payment.settlement, /Only after acceptance is final.*separate signed quote.*\/api\/mpp\/pay.*Stripe's card minimum.*pending production verification/);

  assert.deepEqual(receipt.required, ['gaps', 'rows', 'accepted_count']);
  assert.deepEqual(Object.keys(receipt.properties), receipt.required);
  assert.deepEqual(receipt.properties.accepted_count.type, ['integer', 'null']);
  const row = receipt.properties.rows.items;
  assert.deepEqual(row.required, ['account_domain', 'fit_note', 'owning_role', 'role_source_url', 'trigger', 'opener']);
  assert.deepEqual(row.properties.trigger.required, ['summary', 'source_url', 'date']);

  for (const copy of [home, llms]) assert.ok(copy.includes('$0.05 USD per accepted row'));
  for (const phrase of ['3 rows free', '90 calendar days', '48 hours', '24 hours', '/api/mpp/pay', 'a separate signed quote for each accepted paid row', "Stripe's card minimum"]) {
    assert.ok(llms.includes(phrase), phrase);
  }
});

test('the linked public ledger separates test payments from outside-buyer work', () => {
  const { ledger_url: url } = JSON.parse(read('public/offer.json'));
  const ledger = JSON.parse(read('public' + url));
  assert.equal(url, '/ledger.json');
  assert.deepEqual(ledger.outside_buyer_revenue, { amount_minor: 0, currency: 'USD' });
  assert.equal(ledger.payments, 'test payments only');
  assert.deepEqual(ledger.outside_buyer_jobs, { agreed: 0, completed: 0 });
  assert.ok(read('public/index.html').includes(`href="${url}">Public ledger`));
  assert.ok(read('public/llms.txt').includes(`(${url})`));
});

test('marketplace payment discovery publishes the durable routes and fixed batch price', () => {
  const { evidence_brief: { marketplace_payment: batch, price }, url } = JSON.parse(read('public/offer.json'));
  const llms = read('public/llms.txt');
  assert.equal(batch.product_id, 'evidence-brief-10');
  assert.equal(batch.accepted_row_count, 20);
  assert.match(batch.instructions, /20 accepted paid rows/);
  assert.match(llms, /20 accepted paid rows/);
  assert.deepEqual(batch.price, { amount_minor: 100, currency: 'USD' });
  assert.equal(batch.price.amount_minor, batch.accepted_row_count * price.amount_minor_per_row);
  assert.equal(batch.card_url, new URL(`/q/${batch.product_id}`, url).href);
  assert.equal(batch.mpp_url, new URL(`/api/mpp/pay?product=${batch.product_id}`, url).href);
  for (const link of [batch.card_url, batch.mpp_url]) assert.ok(llms.includes(`(${link})`));
});

test('site and agent docs expose the agency inbox and marketplace listings', () => {
  const { contact, listings } = JSON.parse(read('public/offer.json'));
  const home = read('public/index.html');
  const quote = read('public/quote/index.html');
  const llms = read('public/llms.txt');

  assert.equal(contact.email, 'dane@phantompipe.com');
  assert.ok(quote.includes('href="mailto:' + contact.email + '"'));
  assert.ok(llms.includes(contact.email));
  assert.deepEqual(listings.map(({ name }) => name), ['Virtuals ACP', 'dealwork.ai']);
  for (const { url } of listings) {
    assert.ok(home.includes('href="' + url + '"'));
    assert.ok(llms.includes('(' + url + ')'));
  }
});

test('lab notes are discoverable from the homepage and machine-readable indexes', () => {
  const notes = read('public/lab-notes/index.html');
  const url = 'https://phantompipe.com/lab-notes/';
  assert.ok(read('public/index.html').includes('href="/lab-notes/">Lab notes'));
  assert.ok(read('public/llms.txt').includes('(' + url + ')'));
  assert.ok(read('public/sitemap.xml').includes('<loc>' + url + '</loc>'));
  assert.ok(notes.includes('rel="canonical" href="' + url + '"'));
  assert.equal([...notes.matchAll(/<li class="note">/g)].length, 8);
  assert.doesNotMatch(notes, /\bagent-run\b/i);
});

test('sample request link keeps a contrasting label on hover', () => {
  assert.match(read('public/lab-notes/index.html'), /<a class="button"[^>]*>Request a free sample/);
  assert.match(read('public/styles.css'), /\.button:hover\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--paper\);/);
});

test('legacy x402 manifest points to free resources without offering payment', () => {
  const manifest = JSON.parse(read('public/.well-known/x402.json'));
  const offer = JSON.parse(read('public/offer.json'));

  assert.equal(manifest.x402Version, 2);
  assert.equal(manifest.name, offer.name);
  assert.equal(manifest.url, offer.url);
  assert.equal(manifest.payment, 'removed');
  assert.deepEqual(manifest.services, []);
  assert.ok(!('pending_payment' in manifest));
  assert.ok(!('payTo' in manifest));
  assert.deepEqual(manifest.resources.map(({ method, path }) => [method, path]), [
    ['GET', '/offer.json'],
    ['GET', '/quote/'],
  ]);
});

test('offer and llms document issued-quote payment rails without claiming live availability', () => {
  const offer = JSON.parse(read('public/offer.json'));
  const { quote_payment } = JSON.parse(read('docs/offer-payments.fragment.json'));
  const llms = read('public/llms.txt');

  assert.equal(offer.payment, 'coming soon');
  assert.deepEqual(offer.quote_payment, quote_payment);
  assert.equal(offer.quote_payment.agent_mpp.status, 'pending');
  assert.ok(!('agent_usdc' in offer.quote_payment));
  assert.match(llms, /Individual \$0\.05 evidence brief quotes are Tempo MPP only/);
  assert.match(llms, /Tempo MPP is pending production verification/);
  for (const rail of ['human', 'agent', 'agent_mpp']) {
    assert.ok(llms.includes(quote_payment[rail].url_template));
  }
});

test('Surge copy routes human and agent requests to FormSubmit', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'phantom-pipe-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const siteUrl = 'https://pullrequested.surge.sh/';
  const recipient = 'quotes@example.com';
  buildSurge({ siteUrl, recipient, output });
  const asset = (path) => readFileSync(join(output, path), 'utf8');
  const quote = asset('quote/index.html');
  const offer = JSON.parse(asset('offer.json'));
  const llms = asset('llms.txt');

  assert.ok(quote.includes('action="https://formsubmit.co/quotes@example.com"'));
  assert.ok(quote.includes('name="_next" value="' + siteUrl + 'thanks/"'));
  assert.ok(quote.includes('name="_subject" value="New Phantom Pipe quote request"'));
  assert.ok(quote.includes('name="_honey"'));
  assert.doesNotMatch(quote, /data-netlify|name="form-name"/);
  assert.ok(asset('index.html').includes('href="/quote/"'));
  assert.ok(asset('index.html').includes('rel="canonical" href="https://phantompipe.com/"'));
  assert.equal(offer.url, 'https://phantompipe.com/');
  assert.equal(offer.site_url, siteUrl);
  assert.equal(offer.contact.url, siteUrl + 'quote/');
  assert.equal(offer.quote_request.url, 'https://formsubmit.co/ajax/quotes@example.com');
  assert.equal(offer.quote_request.content_type, 'application/json');
  assert.equal(offer.quote_request.json_body, undefined);
  assert.doesNotMatch(llms, /status_url/);
  assert.deepEqual(Object.keys(offer.quote_request.fields), ['name', 'email', 'company', 'service', 'brief']);
  assert.ok(llms.includes(offer.quote_request.url));
  assert.ok(llms.includes('(' + siteUrl + 'offer.json)'));
  assert.ok(llms.includes('(' + offer.contact.url + ')'));
  const canonicalOffer = JSON.parse(read('public/offer.json'));
  assert.deepEqual(offer.quote_payment, canonicalOffer.quote_payment);
  assert.equal(asset(offer.ledger_url.slice(1)), read('public/ledger.json'));
  assert.ok(llms.includes(offer.quote_payment.agent.url_template));
  assert.ok(asset('sitemap.xml').includes('<loc>' + offer.contact.url + '</loc>'));
  assert.ok(llms.includes('(' + siteUrl + 'lab-notes/)'));
  assert.ok(asset('sitemap.xml').includes('<loc>' + siteUrl + 'lab-notes/</loc>'));
  assert.equal(offer.fixed_price_services.url, siteUrl + 'services/');
  assert.equal(offer.fixed_price_services.intake.url, offer.contact.url);
  const expectedServices = canonicalOffer.fixed_price_services.services.map((service) => (
    service.page_url && service.page_url.startsWith(canonicalOffer.url)
      ? { ...service, page_url: new URL(service.page_url.slice(canonicalOffer.url.length), siteUrl).href }
      : service
  ));
  assert.deepEqual(offer.fixed_price_services.services, expectedServices);
  assert.ok(llms.includes('(' + offer.fixed_price_services.url + ')'));
  assert.ok(asset('sitemap.xml').includes('<loc>' + offer.fixed_price_services.url + '</loc>'));
  assert.ok(asset('lab-notes/index.html').includes('href="/quote/"'));
  assert.ok(asset('robots.txt').includes('Sitemap: ' + siteUrl + 'sitemap.xml'));
  assert.equal(asset('.well-known/x402.json'), read('public/.well-known/x402.json'));
  assert.equal(asset('.surgeignore'), '!/.well-known/\n');
});

test('Surge defaults to the agency contact email for quote delivery', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'phantom-pipe-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  buildSurge({ siteUrl: 'https://pullrequested.surge.sh/', output });

  const quote = readFileSync(join(output, 'quote/index.html'), 'utf8');
  const offer = JSON.parse(readFileSync(join(output, 'offer.json'), 'utf8'));
  assert.ok(quote.includes('action="https://formsubmit.co/dane@phantompipe.com"'));
  assert.equal(offer.quote_request.url, 'https://formsubmit.co/ajax/dane@phantompipe.com');
});
