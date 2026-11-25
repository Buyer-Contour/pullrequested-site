const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const read = (path) => readFileSync(resolve(__dirname, '..', path), 'utf8');

test('all public assets exist and are nonempty', () => {
  for (const path of [
    'index.html', 'quote/index.html', 'thanks/index.html', 'styles.css', 'favicon.svg',
    'offer.json', 'llms.txt', 'robots.txt', 'sitemap.xml',
  ]) {
    assert.ok(read(`public/${path}`).trim(), path);
  }
});

test('offer and agent instructions match the Netlify form', () => {
  const offer = JSON.parse(read('public/offer.json'));
  const { url, method, content_type, fields } = offer.quote_request;
  const quote = read('public/quote/index.html');
  const llms = read('public/llms.txt');

  assert.equal(offer.contact.url, url);
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
