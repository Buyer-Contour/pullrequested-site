const responseWindowHours = 48;
const receiptLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const services = new Set(['pipeline-research', 'gtm-data-ops', 'outbound-systems', 'gtm-automation', 'not-sure']);
const receiptPath = '/quote/status/';

function mediaType(request) {
  return request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
}

export function wantsQuoteReceipt(request) {
  return mediaType(request) === 'application/json' || Boolean(request.headers.get('Accept')?.split(',').some((entry) => {
    const [type, ...params] = entry.toLowerCase().split(';').map((part) => part.trim());
    const quality = params.find((param) => param.startsWith('q='));
    return type === 'application/json' && (quality === undefined || Number(quality.slice(2)) > 0);
  }));
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function receipt(request, id) {
  return {
    request_id: id,
    status: 'received',
    response_window: responseWindowHours,
    status_url: new URL(receiptPath + id, request.url).href,
  };
}

export async function submitQuote(request, env, forward) {
  const type = mediaType(request);
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
    return json({ error: 'Unsupported content type.' }, 415);
  }

  let fields;
  try {
    const body = type === 'application/json' ? await request.json() : Object.fromEntries(await request.formData());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    if ((type !== 'application/json' || Object.hasOwn(body, 'form-name')) && body['form-name'] !== 'quote') throw new Error();
    fields = new URLSearchParams({ 'form-name': 'quote' });
    for (const key of ['name', 'email', 'service', 'brief', 'company', 'bot-field']) {
      const value = Object.hasOwn(body, key) ? body[key] : '';
      if (typeof value !== 'string') throw new Error();
      fields.set(key, value.trim());
    }
    if (!fields.get('name') || !fields.get('brief') || !services.has(fields.get('service')) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.get('email')) || fields.get('bot-field')) throw new Error();
  } catch {
    return json({ error: 'Provide a name, reply-to email, supported service, and brief.' }, 400);
  }

  const id = crypto.randomUUID();
  fields.set('brief', fields.get('brief') + '\n\nQuote request ID: ' + id);
  try {
    const upstream = await forward(new Request(request.url, { method: 'POST', body: fields }));
    const location = upstream.headers.get('Location');
    const redirectedToThanks = [302, 303].includes(upstream.status) && location &&
      ['/thanks', '/thanks/'].includes(new URL(location, 'https://phantompipe.netlify.app').pathname);
    if (!upstream.ok && !redirectedToThanks) {
      return json({ error: 'Quote intake is unavailable. Contact dane@phantompipe.com.' }, 502);
    }
  } catch {
    return json({ error: 'Quote intake is unavailable. Contact dane@phantompipe.com.' }, 502);
  }

  const result = receipt(request, id);
  try {
    const saved = await env.QUOTE_RECEIPTS.getByName(id).fetch('https://receipt.internal/', { method: 'POST' });
    if (!saved.ok) throw new Error();
  } catch {
    return json({ error: 'The request was forwarded, but no receipt could be saved. Contact dane@phantompipe.com with the request ID.', request_id: id }, 503);
  }
  return json(result, 202, { Location: result.status_url, Vary: 'Accept' });
}

export async function quoteStatus(request, env, pathname) {
  const id = pathname.slice(receiptPath.length);
  let response;
  if (!['GET', 'HEAD'].includes(request.method)) {
    response = json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, HEAD' });
  } else if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id)) {
    response = json({ error: 'Quote request not found.' }, 404);
  } else {
    try {
      const stored = await env.QUOTE_RECEIPTS.getByName(id).fetch('https://receipt.internal/');
      response = stored.ok
        ? json(receipt(request, id))
        : json({ error: 'Quote request not found.' }, 404);
    } catch {
      response = json({ error: 'Quote status is unavailable.' }, 503);
    }
  }
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

export class QuoteReceipts {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const expiresAt = Date.now() + receiptLifetimeMs;
      await this.storage.setAlarm(expiresAt);
      this.storage.kv.put('expiresAt', expiresAt);
      return new Response(null, { status: 204 });
    }
    const expiresAt = this.storage.kv.get('expiresAt');
    return new Response(null, { status: expiresAt > Date.now() ? 204 : 404 });
  }

  async alarm() {
    this.storage.kv.delete('expiresAt');
  }
}
