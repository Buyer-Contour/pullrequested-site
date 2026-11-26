import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import site from '../workers/site.mjs';

const origin = 'https://phantompipe.com';
const endpoint = origin + '/mcp';
const catalog = await readFile(new URL('../public/offer.json', import.meta.url), 'utf8');
const offer = JSON.parse(catalog);

function workerFetch() {
  const saved = new Set();
  return (input, init) => site.fetch(new Request(input, init), {
    ASSETS: {
      fetch(request) {
        assert.equal(new URL(request.url).pathname, '/offer.json');
        return new Response(catalog);
      },
    },
    PAYMENTS_STATE: { getByName: () => ({ incrementVariant() {} }) },
    QUOTE_RECEIPTS: {
      getByName(id) {
        return { fetch: (_url, { method } = {}) => {
          if (method === 'POST') saved.add(id);
          return new Response(null, { status: saved.has(id) ? 204 : 404 });
        } };
      },
    },
  });
}

test('MCP SDK discovers offers, reads payment URLs, and submits and reads an intake receipt', async (t) => {
  const fetch = workerFetch();
  const forwarded = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    assert.equal(request.url, 'https://phantompipe.netlify.app/thanks/');
    forwarded.push(await request.formData());
    return new Response(null, { status: 303, headers: { Location: '/thanks/' } });
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { fetch });
  const client = new Client({ name: 'phantom-pipe-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  assert.equal(client.getServerVersion().name, 'phantom-pipe');
  assert.deepEqual(await client.ping(), {});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), [
    'list_offers', 'get_offer', 'submit_brief', 'get_quote_request_status', 'get_quote_payment_links',
  ]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const list = await call('list_offers');
  assert.deepEqual(list.structuredContent.fixed_price_services, offer.fixed_price_services.services);
  assert.deepEqual(list.structuredContent.evidence_brief.price, offer.evidence_brief.price);
  const { product_id, card_url, mpp_url } = offer.evidence_brief.marketplace_payment;
  const item = (await call('get_offer', { id: product_id })).structuredContent;
  assert.equal(item.card_url, card_url);
  assert.equal(item.mpp_url, mpp_url);
  assert.equal((await call('get_offer', { id: 'missing' })).isError, true);
  const links = (await call('get_quote_payment_links', { signed_quote_token: 'token+/=' })).structuredContent;
  assert.equal(links.card_url, origin + '/q/token%2B%2F%3D');
  assert.equal(new URL(links.mpp_url).searchParams.get('quote'), 'token+/=');
  assert.equal(new URL(links.stripe_agent_url).searchParams.get('quote'), 'token+/=');
  assert.equal(forwarded.length, 0);

  const args = { name: 'Test Buyer', email: 'buyer@example.com', service: 'pipeline-research', brief: 'Please send the three free sample rows.' };
  const invalid = await call('submit_brief', { ...args, email: 'invalid' });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.http_status, 400);
  const submitted = (await call('submit_brief', args)).structuredContent;
  assert.equal(submitted.status, 'received');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].get('brief'), args.brief + '\n\nQuote request ID: ' + submitted.request_id);
  assert.deepEqual((await call('get_quote_request_status', { request_id: submitted.request_id })).structuredContent, submitted);
  const missing = await call('get_quote_request_status', { request_id: crypto.randomUUID() });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.http_status, 404);
});

test('MCP enforces transport and JSON-RPC rules without executing notifications', async () => {
  const fetch = workerFetch();
  const post = (body, headers) => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body,
  });
  const send = (method, params, id = 1) => post(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const get = await fetch(endpoint, { headers: { Accept: 'text/event-stream' } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal((await post('{}', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{}', { Accept: 'text/event-stream' })).status, 406);
  assert.equal((await post('{}', { 'MCP-Protocol-Version': '2030-01-01' })).status, 400);
  const malformed = await post('{');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  assert.equal((await post('[' + ' '.repeat(65536) + ']')).status, 413);
  assert.equal((await (await post('[]')).json()).error.code, -32600);
  assert.equal((await (await send('unknown')).json()).error.code, -32601);
  assert.equal((await (await send('tools/call', { name: 'get_offer', arguments: { id: 'a', extra: 'b' } })).json()).error.code, -32602);

  const init = (protocolVersion) => send('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal((await (await init('2025-03-26')).json()).result.protocolVersion, '2025-03-26');
  assert.equal((await (await init('unknown')).json()).result.protocolVersion, '2025-11-25');
  const notice = await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notice.status, 202);
  assert.equal(await notice.text(), '');
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).status, 202);
});

test('MCP 2025-03-26 batches return only request responses and reject empty batches', async () => {
  const fetch = workerFetch();
  const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const request = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const call = { jsonrpc: '2.0', id: 'offer', method: 'tools/call', params: { name: 'get_offer', arguments: { id: 'evidence-brief' } } };
  const post = (entries, version = '2025-03-26') => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': version },
    body: JSON.stringify(entries),
  });
  const response = await post([notification, request, call, null]);
  assert.equal(response.status, 200);
  const [ping, offer, invalid, ...extra] = await response.json();
  assert.deepEqual(ping, { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(offer.id, 'offer');
  assert.equal(offer.result.structuredContent.id, 'evidence-brief');
  assert.equal(invalid.id, null);
  assert.equal(invalid.error.code, -32600);
  assert.deepEqual(extra, []);

  const onlyNotifications = await post([notification, notification]);
  assert.equal(onlyNotifications.status, 202);
  assert.equal(await onlyNotifications.text(), '');
  for (const [entries, version] of [[[], '2025-03-26'], [[request], '2025-06-18'], [[request], '2025-11-25']]) {
    const rejected = await post(entries, version);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, -32600);
  }
});

test('MCP GET describes the endpoint to browsers and JSON clients but declines event streams', async () => {
  const fetch = workerFetch();
  const docs = '/docs/#mcp';
  const serverCard = '/.well-known/mcp.json';
  for (const accept of [undefined, 'application/json, text/event-stream;q=0']) {
    const response = await fetch(endpoint, accept ? { headers: { Accept: accept } } : undefined);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.equal(response.headers.get('Vary'), 'Accept');
    const body = await response.json();
    assert.equal(body.docs, docs);
    assert.equal(body.server_card, serverCard);
  }
  const browser = await fetch(endpoint, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get('Content-Type'), /^text\/html/);
  const html = await browser.text();
  for (const url of [docs, serverCard]) assert.ok(html.includes(`href="${url}"`));

  const sse = await fetch(endpoint, { headers: { Accept: 'application/json, text/event-stream' } });
  assert.equal(sse.status, 405);
  assert.equal(sse.headers.get('Allow'), 'POST');
  assert.equal(sse.headers.get('Vary'), 'Accept');
});
