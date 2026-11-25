const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSurge } = require('../scripts/build-surge');

const read = (path) => readFileSync(resolve(__dirname, '..', path), 'utf8');

test('all public assets exist and are nonempty', () => {
  for (const path of [
    'index.html', 'quote/index.html', 'thanks/index.html', 'styles.css', 'favicon.svg',
    'offer.json', 'llms.txt', 'robots.txt', 'sitemap.xml',
    '.well-known/x402.json',
  ]) {
    assert.ok(read(`public/${path}`).trim(), path);
  }
});

test('offer and agent instructions match the Netlify form', () => {
  const offer = JSON.parse(read('public/offer.json'));
  const { url, method, content_type, fields } = offer.quote_request;
  const quote = read('public/quote/index.html');
  const llms = read('public/llms.txt');

  assert.equal(offer.name, 'pullrequested.com');
  assert.equal(offer.url, 'https://pullrequested.com/');
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

test('site and agent docs expose the agency inbox and marketplace listings', () => {
  const { contact, listings } = JSON.parse(read('public/offer.json'));
  const home = read('public/index.html');
  const quote = read('public/quote/index.html');
  const llms = read('public/llms.txt');

  assert.equal(contact.email, 'pullrequested@agentmail.to');
  assert.ok(quote.includes('href="mailto:' + contact.email + '"'));
  assert.ok(llms.includes(contact.email));
  assert.deepEqual(listings.map(({ name }) => name), ['Virtuals ACP', 'dealwork.ai']);
  for (const { url } of listings) {
    assert.ok(home.includes('href="' + url + '"'));
    assert.ok(llms.includes('(' + url + ')'));
  }
});

test('pending x402 manifest points to free resources without offering payment', () => {
  const manifest = JSON.parse(read('public/.well-known/x402.json'));
  const offer = JSON.parse(read('public/offer.json'));

  assert.equal(manifest.x402Version, 2);
  assert.equal(manifest.name, offer.name);
  assert.equal(manifest.url, offer.url);
  assert.equal(manifest.payment, 'pending');
  assert.deepEqual(manifest.services, []);
  assert.equal(manifest.pending_payment.path, '/api/x402/pay');
  assert.equal(manifest.pending_payment.requires_issued_quote, true);
  assert.equal(manifest.pending_payment.discovery_extension, 'bazaar');
  assert.ok(!('payTo' in manifest));
  assert.deepEqual(manifest.resources.map(({ method, path }) => [method, path]), [
    ['GET', '/offer.json'],
    ['GET', '/quote/'],
  ]);
});

test('Surge copy routes human and agent requests to FormSubmit', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'pullrequested-test-'));
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
  assert.ok(quote.includes('name="_honey"'));
  assert.doesNotMatch(quote, /data-netlify|name="form-name"/);
  assert.ok(asset('index.html').includes('href="/quote/"'));
  assert.ok(asset('index.html').includes('rel="canonical" href="https://pullrequested.com/"'));
  assert.equal(offer.url, 'https://pullrequested.com/');
  assert.equal(offer.site_url, siteUrl);
  assert.equal(offer.contact.url, siteUrl + 'quote/');
  assert.equal(offer.quote_request.url, 'https://formsubmit.co/ajax/quotes@example.com');
  assert.equal(offer.quote_request.content_type, 'application/json');
  assert.deepEqual(Object.keys(offer.quote_request.fields), ['name', 'email', 'company', 'service', 'brief']);
  assert.ok(llms.includes(offer.quote_request.url));
  assert.ok(llms.includes('(' + siteUrl + 'offer.json)'));
  assert.ok(llms.includes('(' + offer.contact.url + ')'));
  assert.ok(asset('sitemap.xml').includes('<loc>' + offer.contact.url + '</loc>'));
  assert.ok(asset('robots.txt').includes('Sitemap: ' + siteUrl + 'sitemap.xml'));
  assert.equal(asset('.well-known/x402.json'), read('public/.well-known/x402.json'));
});
