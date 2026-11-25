import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import site from '../workers/site.mjs';

const origin = 'https://phantompipe.com';
const inbox = 'dane@phantompipe.com';
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
  QUOTE_INBOX: inbox,
  AGENTMAIL_API_KEY: 'test-key',
};

const quote = {
  'form-name': 'quote', name: 'Test requester', email: 'example@example.com',
  company: 'Test + Co', service: 'not-sure', brief: 'Find prospects in Montréal.',
};

function get(path, init) {
  return site.fetch(new Request(origin + path, init), env);
}

function submit(path, fields = quote) {
  return get(path, { method: 'POST', body: new URLSearchParams(fields) });
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

test('browser and agent submissions forward to the same inbox before acknowledging', async (t) => {
  const send = t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://api.agentmail.to/v0/inboxes/dane%40phantompipe.com/messages/send');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(request.body), {
      to: [inbox],
      reply_to: [quote.email],
      subject: 'New Phantom Pipe quote request',
      text: 'Name: Test requester\nEmail: example@example.com\nCompany or agent: Test + Co\nService: not-sure\n\nFind prospects in Montréal.',
    });
    return new Response(null, { status: 200 });
  });
  const agent = await submit('/quote');
  assert.equal(agent.status, 200);
  assert.match(await agent.text(), /<h1>Thanks\.<\/h1>/);
  assert.equal(agent.headers.get('Cache-Control'), 'no-store');
  const browser = await submit('/thanks/');
  assert.equal(browser.status, 303);
  assert.equal(browser.headers.get('Location'), '/thanks/');
  assert.match(await (await get('/thanks/')).text(), /<h1>Thanks\.<\/h1>/);
  assert.equal(send.mock.callCount(), 2);
});

test('invalid or honeypot submissions are not emailed', async (t) => {
  const send = t.mock.method(globalThis, 'fetch', async () => new Response(null));
  assert.equal((await submit('/quote', { ...quote, 'bot-field': 'spam' })).status, 200);
  assert.equal((await submit('/quote', { ...quote, email: 'bad' })).status, 400);
  assert.equal((await submit('/quote', { ...quote, service: 'invalid' })).status, 400);
  assert.equal((await submit('/quote', { ...quote, brief: 'a'.repeat(16 * 1024) })).status, 413);
  assert.equal((await get('/quote', { method: 'POST', body: '{}' })).status, 415);
  assert.equal(send.mock.callCount(), 0);
});

test('provider failure never returns a successful quote acknowledgment', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }));
  const response = await submit('/thanks/');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Location'), null);
});
