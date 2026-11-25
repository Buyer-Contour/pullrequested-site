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

test('public assets and payment fragments use the Phantom Pipe brand', () => {
  for (const path of [
    'public/index.html', 'public/quote/index.html', 'public/thanks/index.html',
    'public/offer.json', 'public/llms.txt', 'public/.well-known/x402.json',
    'public/robots.txt', 'public/sitemap.xml',
    'docs/offer-payments.fragment.json', 'docs/llms-payments.fragment.txt',
  ]) {
    assert.doesNotMatch(read(path), /pullrequested/i, path);
  }
  for (const path of ['index.html', 'quote/index.html', 'thanks/index.html']) {
    assert.match(read(`public/${path}`), /aria-label="Phantom Pipe home"/, path);
  }
  assert.match(read('public/llms.txt'), /^# Phantom Pipe\n/);
  assert.ok(read('public/robots.txt').includes('Sitemap: https://phantompipe.com/sitemap.xml'));
  assert.ok(read('public/sitemap.xml').includes('<loc>https://phantompipe.com/quote</loc>'));
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

test('the agent-run lab keeps human and agent entry points discoverable', () => {
  const home = read('public/index.html');
  const { description } = JSON.parse(read('public/offer.json'));
  const llms = read('public/llms.txt');

  for (const source of [home, description, llms]) {
    assert.match(source, /fully run and managed by AI agents/i);
    assert.match(source, /humans and agents/i);
    assert.doesNotMatch(source, /\b(?:Clay|Matthew)\b/i);
  }
  assert.match(home, /rel="canonical" href="https:\/\/phantompipe\.com\/"/);
  assert.match(home, /href="\/quote">Request a free sample/);
  assert.match(home, /href="\/offer\.json">Read the agent spec/);
  assert.match(home, /href="\/llms\.txt"/);
  assert.match(home, /Demo feed/);
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
  assert.match(llms, /Stripe routes currently return HTTP 503/);
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
  assert.deepEqual(Object.keys(offer.quote_request.fields), ['name', 'email', 'company', 'service', 'brief']);
  assert.ok(llms.includes(offer.quote_request.url));
  assert.ok(llms.includes('(' + siteUrl + 'offer.json)'));
  assert.ok(llms.includes('(' + offer.contact.url + ')'));
  const canonicalOffer = JSON.parse(read('public/offer.json'));
  assert.deepEqual(offer.quote_payment, canonicalOffer.quote_payment);
  assert.ok(llms.includes(offer.quote_payment.agent.url_template));
  assert.ok(asset('sitemap.xml').includes('<loc>' + offer.contact.url + '</loc>'));
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
