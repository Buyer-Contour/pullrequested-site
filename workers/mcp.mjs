import { quoteServices } from './quote-intake.mjs';

const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const defaultProtocolVersion = '2025-03-26';
const maxBodyBytes = 64 * 1024;
const bodyTooLarge = Symbol();
const headers = { 'Cache-Control': 'no-store' };
const string = { type: 'string', minLength: 1 };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const readOnly = { readOnlyHint: true, openWorldHint: false };
const tools = [
  {
    name: 'list_offers',
    description: 'List Phantom Pipe services, published prices, and samples. Scoped work may need a quote.',
    annotations: readOnly,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_offer',
    description: 'Read a specific offer by ID from list_offers, including any published payment links. Does not open a payment link or charge anything.',
    annotations: readOnly,
    inputSchema: { type: 'object', properties: { id: string }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'submit_brief',
    description: 'Send an inquiry with the buyer’s permission. To request the free evidence-brief sample, choose pipeline-research and explicitly ask for the three free rows in brief. Returns an intake receipt, not a signed quote; does not collect payment. Do not send confidential material or payment credentials.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { name: string, email: { ...string, format: 'email' }, service: { type: 'string', enum: quoteServices }, brief: string, company: { type: 'string' } },
      required: ['name', 'email', 'service', 'brief'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_quote_request_status',
    description: 'Look up an intake receipt by request_id. “received” does not confirm a reply, quote issuance, or payment.',
    annotations: readOnly,
    inputSchema: { type: 'object', properties: { request_id: string }, required: ['request_id'], additionalProperties: false },
  },
  {
    name: 'get_quote_payment_links',
    description: 'Build payment links for an already-issued signed quote token. Does not validate the token, check payment status, or initiate payment. Use only the rail specified for your quote.',
    annotations: readOnly,
    inputSchema: { type: 'object', properties: { signed_quote_token: string }, required: ['signed_quote_token'], additionalProperties: false },
  },
];

function rpcFailure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcError(id, code, message, status) {
  return Response.json(rpcFailure(id, code, message), { status, headers });
}

function validArguments(args, schema) {
  return object(args)
    && schema.required?.every((key) => Object.hasOwn(args, key)) !== false
    && Object.entries(args).every(([key, value]) => Object.hasOwn(schema.properties, key)
      && typeof value === 'string' && value.trim().length >= (schema.properties[key].minLength ?? 0)
      && schema.properties[key].enum?.includes(value) !== false);
}

function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError && { isError }) };
}

async function callTool(name, args, siteRequest) {
  if (name === 'submit_brief' || name === 'get_quote_request_status') {
    if (name === 'get_quote_request_status' && !/^[a-f0-9-]{36}$/.test(args.request_id)) {
      return toolResult({ error: 'Quote request not found.' }, true);
    }
    const response = name === 'submit_brief'
      ? await siteRequest('/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      : await siteRequest('/quote/status/' + args.request_id);
    const data = await response.json();
    return toolResult(response.ok ? data : { ...data, http_status: response.status }, !response.ok);
  }

  const response = await siteRequest('/offer.json');
  if (!response.ok) return toolResult({ error: 'Offer catalog is unavailable.' }, true);
  const offer = await response.json();

  if (name === 'get_quote_payment_links') {
    const token = encodeURIComponent(args.signed_quote_token);
    const { human, agent, agent_mpp: mpp } = offer.quote_payment;
    return toolResult({
      card_url: human.url_template.replace('{signed_quote_token}', token),
      mpp_url: mpp.url_template.replace('{signed_quote_token}', token),
      stripe_agent_url: agent.url_template.replace('{signed_quote_token}', token),
    });
  }

  const { services, evidence_brief: evidence, fixed_price_services: fixed, per_row_pricing: perRow, quote_request: intake } = offer;
  const marketplace = evidence.marketplace_payment;
  const evidenceOffer = { id: 'evidence-brief', ...evidence };
  const marketplaceOffer = { id: marketplace.product_id, name: 'Evidence brief marketplace batch', ...marketplace };
  if (name === 'get_offer') {
    const item = [...fixed.services, ...services, evidenceOffer, marketplaceOffer].find(({ id }) => id === args.id);
    return item ? toolResult(item) : toolResult({ error: 'Offer not found.' }, true);
  }

  return toolResult({
    offer_url: new URL('/offer.json', offer.url).href,
    fixed_price_services: fixed.services,
    scoped_services: services.map(({ id, name: serviceName, deliverables, sample }) => ({
      id, name: serviceName, deliverables, ...(sample && { sample_price: sample.price }),
    })),
    evidence_brief: { id: evidenceOffer.id, name: evidence.name, price: evidence.price, sample: evidence.sample },
    marketplace_batch: marketplaceOffer,
    per_row_pricing: perRow,
    quote_request: intake,
  });
}

async function readMessage(request) {
  if (Number(request.headers.get('Content-Length')) > maxBodyBytes) return bodyTooLarge;
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBodyBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (value.byteLength > bytes.length - length) {
        void reader.cancel().catch(() => {});
        return bodyTooLarge;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function accepts(header, types) {
  return header?.split(',').some((entry) => {
    const [type, ...params] = entry.toLowerCase().split(';').map((part) => part.trim());
    return types.includes(type)
      && !params.some((param) => /^q\s*=/.test(param) && Number(param.split('=')[1]) === 0);
  });
}

function describeMcp(accept) {
  const responseHeaders = { ...headers, Vary: 'Accept' };
  if (accepts(accept, ['text/event-stream'])) {
    return new Response(null, { status: 405, headers: { ...responseHeaders, Allow: 'POST' } });
  }
  const docs = '/docs/#mcp';
  const serverCard = '/.well-known/mcp.json';
  const description = 'Connect an MCP client using Streamable HTTP. Send JSON-RPC requests by POST to /mcp.';
  if (accepts(accept, ['text/html'])) {
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phantom Pipe MCP</title><link rel="stylesheet" href="/styles.css"><main class="wrap"><h1>Phantom Pipe MCP</h1><p>${description}</p><p><a href="${docs}">MCP setup guide</a> · <a href="${serverCard}">Server card</a></p></main></html>`,
      { headers: { ...responseHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  return Response.json({ name: 'phantom-pipe', description, docs, server_card: serverCard }, { headers: responseHeaders });
}

export async function handleMcp(request, siteRequest) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return rpcError(null, -32000, 'Origin not allowed.', 403);
  }
  const accept = request.headers.get('Accept');
  if (request.method === 'GET') return describeMcp(accept);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return rpcError(null, -32000, 'Use application/json.', 415);
  if (accept && !accepts(accept, ['application/json', 'application/*', '*/*'])) {
    return rpcError(null, -32000, 'Accept application/json.', 406);
  }
  const version = request.headers.get('MCP-Protocol-Version') ?? defaultProtocolVersion;
  if (!protocolVersions.includes(version)) return rpcError(null, -32000, 'Unsupported MCP protocol version.', 400);

  let message;
  try {
    message = await readMessage(request);
  } catch {
    return rpcError(null, -32700, 'Parse error.', 400);
  }
  if (message === bodyTooLarge) {
    return rpcError(null, -32000, 'MCP body exceeds 64 KiB.', 413);
  }
  if (Array.isArray(message)) {
    if (version !== '2025-03-26' || !message.length) {
      return rpcError(null, -32600, 'Invalid request.', 400);
    }
    const replies = [];
    for (const entry of message) {
      const reply = await dispatch(entry, siteRequest);
      if (reply) replies.push(reply);
    }
    return replies.length
      ? Response.json(replies, { headers })
      : new Response(null, { status: 202, headers });
  }
  const reply = await dispatch(message, siteRequest);
  return reply
    ? Response.json(reply, { status: reply.error?.code === -32600 ? 400 : 200, headers })
    : new Response(null, { status: 202, headers });
}

async function dispatch(message, siteRequest) {
  if (!object(message) || message.jsonrpc !== '2.0') {
    return rpcFailure(null, -32600, 'Invalid request.');
  }
  const { id, method, params } = message;
  const validId = typeof id === 'string' || Number.isSafeInteger(id);
  if (method === undefined && (validId || id === null)
    && ((object(message.result) && message.error === undefined)
      || (message.result === undefined && Number.isSafeInteger(message.error?.code) && typeof message.error.message === 'string'))) {
    return;
  }
  if (typeof method !== 'string' || !method || (Object.hasOwn(message, 'id') && !validId)
    || (id === undefined && params !== undefined && !object(params))) {
    return rpcFailure(null, -32600, 'Invalid request.');
  }
  if (id === undefined) return;
  if (params !== undefined && !object(params)) return rpcFailure(id, -32602, 'Invalid params.');

  let result;
  if (method === 'initialize') {
    if (typeof params?.protocolVersion !== 'string' || !object(params.capabilities)
      || typeof params.clientInfo?.name !== 'string' || typeof params.clientInfo?.version !== 'string') {
      return rpcFailure(id, -32602, 'Invalid initialize params.');
    }
    result = {
      protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'phantom-pipe', version: '1.0.0' },
      instructions: 'Discover offers and prices, submit a brief with permission, or check an intake receipt. Payment happens outside MCP.',
    };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'tools/call') {
    const tool = tools.find(({ name }) => name === params?.name);
    if (!tool) return rpcFailure(id, -32602, 'Unknown tool.');
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!validArguments(args, tool.inputSchema)) return rpcFailure(id, -32602, 'Invalid tool arguments.');
    try {
      result = await callTool(tool.name, args, siteRequest);
    } catch {
      result = toolResult({ error: 'The tool is temporarily unavailable.' }, true);
    }
  } else {
    return rpcFailure(id, -32601, 'Method not found.');
  }
  return { jsonrpc: '2.0', id, result };
}
