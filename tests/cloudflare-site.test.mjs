import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import site from '../workers/site.mjs';

const origin = 'https://phantompipe.com';
const env = {
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

test('Cloudflare serves the homepage, quote form, and agent discovery with the expected headers', async () => {
  assert.match(await (await get('/')).text(), /The agent-run GTM lab/);
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
