import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../api/worker.js';
import { comparePricing, extractPricing } from '../src/pricing.js';
import { fetchPublicHtml, PublicUrlError, parsePublicUrl } from '../src/public-page.js';

const page = (cost) => `<html><head><title>Plans</title></head><body>
  <nav>$500</nav><main><h1>Pricing</h1><section>
  <div><h2>Pro</h2></div>
  <p><span>$</span><strong>${cost}</strong> per seat</p>
  <p>Annual contract required</p><p aria-hidden="true">£400</p>
  <p style="display: none">€500</p><script>price='$999'</script>
  </section><section><h2>Business</h2><p>€35 /mo</p></section>
  </main><footer>$99</footer></body></html>`;

test('detects visible prices, billing terms, plan headings and keywords', () => {
  assert.deepEqual(extractPricing(page(12), ['ANNUAL CONTRACT']), {
    title: 'Plans',
    prices: ['$12', '€35'],
    planNames: ['Pro', 'Business'],
    pricingText: 'Pro\n$12 per seat\nAnnual contract required\nBusiness\n€35 /mo',
  });
});

test('leaves badges out of plan names and skips headings next to sales CTAs', () => {
  const html = `<main>
    <section><h3>Free</h3><div>$0</div></section>
    <section><h3>Pro<span class="pricing_badge">Recommended</span></h3><div>$12</div></section>
    <section><h3>Enterprise</h3><div>Custom</div></section>
    <section><h2>Ready to get started?</h2><a>Contact sales</a></section>
  </main>`;
  assert.deepEqual(extractPricing(html).planNames, ['Free', 'Pro', 'Enterprise']);
});

test('establishes a baseline, normalizes spacing and reports changes against text or hash', async () => {
  const url = 'https://example.com/pricing';
  const first = await comparePricing(url, page(10));
  assert.equal(first.changed, false);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  const unchanged = await comparePricing(url, page(10).replace(' per seat', '   per\n seat '), first);
  assert.equal(unchanged.contentHash, first.contentHash);
  assert.equal(unchanged.changed, false);
  const byText = await comparePricing(url, page(12), { pricingText: first.pricingText });
  assert.equal(byText.changed, true);
  assert.deepEqual(byText.addedLines, ['$12 per seat']);
  assert.deepEqual(byText.removedLines, ['$10 per seat']);
  const byHash = await comparePricing(url, page(12), { contentHash: first.contentHash });
  assert.equal(byHash.changed, true);
  assert.deepEqual(byHash.addedLines, []);
});

test('rejects non-web URLs and private addresses, including redirect targets', async () => {
  for (const url of ['file:///page', 'http://localhost', 'http://192.168.1.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]']) {
    assert.throws(() => parsePublicUrl(url), PublicUrlError);
  }
  let requests = 0;
  await assert.rejects(fetchPublicHtml('https://example.com', async (_target, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return { response: Response.redirect('http://127.0.0.1/') };
  }), PublicUrlError);
  assert.equal(requests, 1);
});

test('Worker health and invalid inputs do not fetch an upstream page', async () => {
  const base = 'http://localhost';
  const health = await worker.fetch(new Request(base + '/health'), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const missingProxy = await worker.fetch(new Request(base + '/health'), { RAPIDAPI_PROXY_SECRET: 'fixture-value' });
  assert.equal(missingProxy.status, 401);
  for (const body of ['not JSON', '{"url":"http://127.0.0.1/"}', '{"url":"https://example.com","previousHash":"bad"}']) {
    const result = await worker.fetch(new Request(base + '/v1/check', { method: 'POST', body }), {});
    assert.equal(result.status, 400);
    assert.equal(typeof (await result.json()).error, 'string');
  }
});
