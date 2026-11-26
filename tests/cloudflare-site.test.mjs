import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import site, { QuoteReceipts } from '../workers/site.mjs';

const origin = 'https://phantompipe.com';
const stubStats = { getByName: () => ({ async incrementVariant() {} }) };
const env = {
  PAYMENTS_STATE: stubStats,
  ASSETS: {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      try {
        const bytes = await readFile(new URL(`../public${pathname}`, import.meta.url));
        return new Response(request.method === 'HEAD' ? null : bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

function get(path, init) {
  return site.fetch(new Request(origin + path, init), env);
}

test('API and MCP discovery assets agree with the public site routes', async () => {
  const offer = await (await get('/offer.json')).json();
  const { docs_url, openapi_url, mcp } = offer.integrations;
  assert.equal(docs_url, origin + '/docs/');
  assert.equal(openapi_url, origin + '/openapi.json');
  assert.equal(mcp.url, origin + '/mcp');
  assert.equal(mcp.server_card_url, origin + '/.well-known/mcp.json');
  const [docs, openapi, card, home, llms, sitemap] = await Promise.all(
    ['/docs/', '/openapi.json', '/.well-known/mcp.json', '/', '/llms.txt', '/sitemap.xml'].map((path) => get(path)),
  );
  for (const result of [docs, openapi, card, home, llms, sitemap]) assert.equal(result.status, 200);
  const docsHtml = await docs.text();
  assert.match(docsHtml, /API &amp; <em>MCP docs/);
  for (const result of [openapi, card]) assert.match(result.headers.get('Content-Type'), /^application\/json/);
  const spec = await openapi.json();
  assert.match(spec.openapi, /^3\.1\./);
  const methods = { '/mcp': ['post'], '/quote': ['post'], '/quote/status/{request_id}': ['get'],
    '/q/{quote_or_product}': ['get'], '/api/checkout': ['get', 'post'], '/api/pay': ['get', 'post'],
    '/api/mpp/pay': ['get'], '/api/stripe-webhook': ['post'], '/api/stats/variants': ['get'] };
  for (const [path, verbs] of Object.entries(methods)) {
    for (const verb of verbs) assert.ok(spec.paths[path][verb].responses);
  }
  for (const { page_url } of offer.fixed_price_services.services.filter((item) => item.page_url)) {
    const page = new URL(page_url).pathname;
    assert.ok(docsHtml.includes(`href="${page}"`));
    for (const path of [page, page.slice(0, -1)]) {
      assert.ok(spec.paths[path].get.responses[200]);
      assert.ok(spec.paths[path].head.responses[200]);
    }
  }
  assert.deepEqual((await card.json()).remotes, [{ type: mcp.transport, url: mcp.url }]);
  const homepage = await home.text();
  const guide = await llms.text();
  const sitemapXml = await sitemap.text();
  for (const url of [docs_url, openapi_url, mcp.url]) {
    assert.ok(homepage.includes(`href="${new URL(url).pathname}"`));
    assert.ok(guide.includes(url));
  }
  for (const url of [docs_url, openapi_url, mcp.server_card_url]) assert.ok(sitemapXml.includes(`<loc>${url}</loc>`));
});

function withQuoteReceipts(paymentsState = stubStats) {
  const receipts = new Map();
  return (path, init) => site.fetch(new Request(origin + path, init), {
    ...env,
    PAYMENTS_STATE: paymentsState,
    QUOTE_RECEIPTS: {
      getByName(id) {
        if (!receipts.has(id)) {
          const values = new Map();
          const kv = { get: (key) => values.get(key), put: (key, value) => values.set(key, value) };
          receipts.set(id, new QuoteReceipts({ storage: { kv, async setAlarm() {} } }));
        }
        return { fetch: (url, options) => receipts.get(id).fetch(new Request(url, options)) };
      },
    },
  });
}

test('variant stats report only successful tagged discovery fetches and forwarded quote requests', async (t) => {
  const counts = [];
  const day = new Date().toISOString().slice(0, 10);
  const request = withQuoteReceipts({
    getByName(name) {
      assert.equal(name, 'variant-stats');
      return {
        incrementVariant(event, variant) { counts.push({ day, event, variant, count: 1 }); },
        listVariants() { return counts; },
      };
    },
  });
  const rewrites = [];
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      handler.element({ setAttribute: (name, value) => rewrites.push([selector, name, value]) });
    }
    transform(response) { return response; }
  };
  t.after(() => { delete globalThis.HTMLRewriter; });
  await request('/?v=media-1');
  await request('/quote?v=media-1');
  assert.deepEqual(rewrites, [
    ['a[href="/quote"]', 'href', '/quote?v=media-1'],
    ['a[href="/offer.json"]', 'href', '/offer.json?v=media-1'],
    ['a[href="/llms.txt"]', 'href', '/llms.txt?v=media-1'],
    ['a[href="/services/"]', 'href', '/services/?v=media-1'],
    ['form[name="quote"]', 'action', '/thanks/?v=media-1'],
  ]);
  const offerResponse = await request('/offer.json?v=media-1');
  assert.equal(offerResponse.headers.get('Cache-Control'), 'no-store');
  const offer = await offerResponse.json();
  const quoteUrl = new URL(offer.quote_request.url);
  assert.equal(quoteUrl.href, origin + '/quote?v=media-1');
  assert.equal(offer.contact.url, quoteUrl.href);
  assert.equal(offer.fixed_price_services.url, origin + '/services/?v=media-1');
  assert.equal(offer.fixed_price_services.intake.url, quoteUrl.href);
  const leadListPayUrl = origin + '/q/icp-lead-list?v=svc-icp-lead-list';
  assert.equal(offer.fixed_price_services.services[0].pay_url, leadListPayUrl);
  const { card_url, mpp_url } = offer.evidence_brief.marketplace_payment;
  assert.equal(card_url, origin + '/q/evidence-brief-10?v=media-1');
  assert.equal(mpp_url, origin + '/api/mpp/pay?product=evidence-brief-10&v=media-1');
  const llms = await (await request('/llms.txt?v=invalid%40example.com')).text();
  for (const url of [quoteUrl.href, card_url, mpp_url]) {
    assert.ok(llms.includes(url.replace('v=media-1', 'v=_untagged')));
  }
  assert.ok(llms.includes(origin + '/offer.json?v=_untagged'));
  assert.ok(llms.includes(origin + '/services/?v=_untagged'));
  assert.ok(llms.includes(leadListPayUrl));
  assert.ok(llms.includes(origin + '/q/{signed_quote_token}'));
  assert.ok(!llms.includes('invalid@example.com'));
  await request('/offer.json');
  await request('/llms.txt?v=media-1', { method: 'HEAD' });
  await request('/404?v=media-1');
  let upstreamStatus = 303;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: upstreamStatus, headers: { Location: '/thanks/' } }));
  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ name: 'A Person', email: 'a@example.com', service: 'not-sure', brief: 'Test' });
  const post = (path, init) => request(path, { method: 'POST', headers, body, ...init });
  assert.equal((await post('/quote?v=media-1', { body: '{}' })).status, 400);
  assert.equal((await post(quoteUrl.pathname + quoteUrl.search)).status, 202);
  assert.equal((await post('/thanks/?v=competitive-1')).status, 303);
  upstreamStatus = 502;
  assert.equal((await post('/quote?v=media-1')).status, 502);
  const response = await request('/api/stats/variants');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { counts: [
    { day, event: 'homepage_fetch', variant: 'media-1', count: 1 },
    { day, event: 'offer_fetch', variant: 'media-1', count: 1 },
    { day, event: 'llms_fetch', variant: '_untagged', count: 1 },
    { day, event: 'quote_request', variant: 'media-1', count: 1 },
    { day, event: 'quote_request', variant: 'competitive-1', count: 1 },
  ] });
  assert.equal((await post('/api/stats/variants')).status, 405);
});

test('tagged discovery GET and HEAD ignore static asset validators', async () => {
  const validators = { ETag: '"static"', 'Last-Modified': 'Tue, 24 Nov 2026 01:00:00 GMT' };
  const headers = { 'If-None-Match': validators.ETag, 'If-Modified-Since': validators['Last-Modified'] };
  const conditionalEnv = { ...env, ASSETS: {
    async fetch(request) {
      if (request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since')) {
        return new Response(null, { status: 304, headers: validators });
      }
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, { status: asset.status, headers: validators });
    },
  } };
  for (const method of ['GET', 'HEAD']) {
    const send = (path) => site.fetch(new Request(origin + path, { method, headers }), conditionalEnv);
    assert.equal((await send('/offer.json')).status, 304);
    const response = await send('/offer.json?v=media-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(response.headers.get('Last-Modified'), null);
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.equal((await response.json()).quote_request.url, origin + '/quote?v=media-1');
  }
});

test('www redirects to the canonical apex without changing the path, query, or method', async () => {
  for (const [path, method] of [
    ['/', 'GET'],
    ['/quote/', 'GET'],
    ['/offer.json', 'GET'],
    ['/quote?source=fixture', 'POST'],
    ['/api/pay?quote=signed%2Btoken', 'POST'],
    ['//example.com/path', 'GET'],
  ]) {
    const response = await site.fetch(new Request('https://www.phantompipe.com' + path, { method }), {});
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), origin + path);
  }
});

test('Cloudflare serves the homepage, quote form, and agent discovery with the expected headers', async () => {
  assert.match(await (await get('/')).text(), /An experimental go-to-market agent/);
  for (const path of ['/quote', '/quote/']) {
    assert.match(await (await get(path)).text(), /<form[^>]+name="quote"/);
  }
  const offer = await get('/offer.json');
  assert.equal(offer.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(offer.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal((await offer.json()).quote_request.url, origin + '/quote');
  const llms = await get('/llms.txt', { method: 'HEAD' });
  assert.equal(llms.status, 200);
  assert.equal(llms.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(await llms.text(), '');
  assert.equal((await get('/.well-known/x402.json')).headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal((await get('/nonexistent')).status, 404);
});

test('Cloudflare serves the fixed-price catalog and dedicated offer pages at both directory paths', async () => {
  for (const [path, heading] of [
    ['/services', /Fixed-price services — Phantom Pipe/],
    ['/services/', /Fixed-price services — Phantom Pipe/],
    ['/agent-bill-audit', /AI agent API &amp; hosting bill audit — Phantom Pipe/],
    ['/agent-bill-audit/', /AI agent API &amp; hosting bill audit — Phantom Pipe/],
    ['/scraper-parser', /Fixed-price scraper \/ parser job — Phantom Pipe/],
    ['/scraper-parser/', /Fixed-price scraper \/ parser job — Phantom Pipe/],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), heading);
  }
});

test('Cloudflare serves the canonical receipts page and its samples aliases without masking sample CSVs', async () => {
  const canonical = await get('/receipts/');
  assert.equal(canonical.status, 200);
  const page = await canonical.text();
  assert.match(page, /rel="canonical" href="https:\/\/phantompipe\.com\/receipts\/"/);
  for (const path of ['/receipts', '/samples', '/samples/']) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), page, path);
  }
  const csv = await get('/samples/pipeline-research.csv');
  assert.equal(csv.status, 200);
  assert.doesNotMatch(await csv.text(), /<!doctype html>/i);
});

test('Cloudflare serves the lab notes at both directory paths', async () => {
  for (const path of ['/lab-notes', '/lab-notes/']) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /The purchase is the easy part — Phantom Pipe/);
  }
  const head = await get('/lab-notes/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('browser and agent quote submissions keep their path, query, headers, body and upstream response', async (t) => {
  const body = 'form-name=quote&bot-field=&name=Test+Requester&email=example%40example.com&company=A%2BB&service=not-sure&brief=Montr%C3%A9al';
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: origin,
    Referer: origin + '/quote/',
    'X-Request-Marker': 'fixture',
  };
  const upstream = t.mock.method(globalThis, 'fetch', async (request, options) => {
    const { pathname } = new URL(request.url);
    assert.equal(new URL(request.url).origin, 'https://phantompipe.netlify.app');
    assert.equal(new URL(request.url).search, '?source=fixture');
    assert.equal(request.method, 'POST');
    assert.equal(options.redirect, 'manual');
    for (const [name, value] of Object.entries(headers)) assert.equal(request.headers.get(name), value);
    assert.equal(await request.text(), body);
    return pathname.startsWith('/thanks')
      ? new Response(null, { status: 303, headers: { Location: '/thanks/' } })
      : new Response('Netlify confirmation', { headers: { 'X-Upstream': 'netlify' } });
  });

  for (const path of ['/quote', '/quote/', '/thanks', '/thanks/']) {
    const response = await get(path + '?source=fixture', { method: 'POST', headers, body });
    assert.equal(upstream.mock.calls.at(-1).arguments[0].url, 'https://phantompipe.netlify.app' + path + '?source=fixture');
    if (path.startsWith('/thanks')) {
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('Location'), '/thanks/');
    } else {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-Upstream'), 'netlify');
      assert.equal(await response.text(), 'Netlify confirmation');
    }
  }
  assert.equal(upstream.mock.callCount(), 4);
});

test('quote POST returns a stored receipt for JSON requests and forwards the same ID to Netlify Forms', async (t) => {
  const send = withQuoteReceipts();
  const fields = { name: 'Agent', email: 'agent@example.com', service: 'pipeline-research', brief: 'Montréal' };
  const offer = JSON.parse(await readFile(new URL('../public/offer.json', import.meta.url)));
  const forwarded = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    assert.equal(request.url, 'https://phantompipe.netlify.app/thanks/');
    const form = await request.formData();
    for (const key of ['name', 'email', 'service']) assert.equal(form.get(key), fields[key]);
    assert.equal(form.get('form-name'), 'quote');
    const match = /^Montréal\n\nQuote request ID: (.+)$/.exec(form.get('brief'));
    assert.ok(match);
    forwarded.push(match[1]);
    return forwarded.length === 1 ? new Response('Thanks') : Response.redirect(origin + '/thanks/', 303);
  });

  for (const [path, headers, body] of [
    ['/quote', { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(fields)],
    ['/quote/', { Accept: 'text/html, application/json;q=0.8' }, new URLSearchParams({ 'form-name': 'quote', ...fields })],
  ]) {
    const response = await send(path, { method: 'POST', headers, body });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const result = await response.json();
    const id = forwarded.at(-1);
    const statusPath = '/quote/status/' + id;
    assert.deepEqual(result, {
      request_id: id,
      status: 'received',
      response_window: offer.quote_request.response.response_window,
      status_url: origin + statusPath,
    });
    assert.equal(response.headers.get('Location'), result.status_url);
    assert.deepEqual(await (await send(statusPath)).json(), result);
    const head = await send(statusPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await send(statusPath, { method: 'POST' })).status, 405);
  }
  assert.equal(new Set(forwarded).size, 2);
  assert.equal((await send('/quote/status/' + crypto.randomUUID())).status, 404);
  assert.equal((await send('/quote/status/not-a-request-id')).status, 404);
});

test('invalid quotes and upstream failures do not return a receipt', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response('Offline', { status: 503 }));
  const fields = { name: 'Agent', email: 'agent@example.com', service: 'not-sure', brief: 'Request' };
  const headers = { 'Content-Type': 'application/json' };
  const submit = (body) => get('/quote', { method: 'POST', headers, body });
  assert.equal((await submit('{')).status, 400);
  assert.equal((await submit(JSON.stringify({ ...fields, 'bot-field': 'spam' }))).status, 400);
  assert.equal((await submit(JSON.stringify({ ...fields, service: 'unknown' }))).status, 400);
  assert.equal((await get('/quote', {
    method: 'POST', headers: { Accept: 'application/json' }, body: 'unsupported',
  })).status, 415);
  assert.equal(upstream.mock.callCount(), 0);
  const unavailable = await submit(JSON.stringify(fields));
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).request_id, undefined);
  assert.equal(upstream.mock.callCount(), 1);
});

test('quote intake rejects oversized bodies before parsing or forwarding', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch');
  let headerBodyReads = 0;
  const oversizedHeader = await get('/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '32769' },
    body: new ReadableStream({ pull() { headerBodyReads++; } }, { highWaterMark: 0 }),
    duplex: 'half',
  });
  assert.equal(oversizedHeader.status, 413);
  assert.equal(headerBodyReads, 0);

  for (const headers of [
    { 'Content-Type': 'application/json' },
    { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Content-Length': '3' },
  ]) {
    const chunk = new TextEncoder().encode('é'.repeat(8193));
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (reads++ < 2) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await get('/quote', { method: 'POST', headers, body, duplex: 'half' });
    assert.equal(response.status, 413);
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('the legacy agent verification path retains its origin and other requests are not proxied', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(request.url, 'https://phantompipe.netlify.app/agent-pay-test?quote=fixture');
    return new Response('upstream unavailable', { status: 503 });
  });
  assert.equal((await get('/agent-pay-test?quote=fixture')).status, 503);
  assert.equal((await get('/quote', { method: 'PUT', body: 'fixture' })).status, 405);
  assert.equal((await get('/offer.json', { method: 'POST', body: 'fixture' })).status, 405);
  assert.equal((await get('/api/pay')).status, 404);
  assert.equal(upstream.mock.callCount(), 1);
});
