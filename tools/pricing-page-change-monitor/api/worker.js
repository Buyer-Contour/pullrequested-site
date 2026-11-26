import { comparePricing, failedCheck, validateSnapshot } from '../src/pricing.js';
import { fetchPublicHtml, isPublicAddress, PageError, PublicUrlError } from '../src/public-page.js';

const MAX_INPUT_BYTES = 256_000;
const encoder = new TextEncoder();

async function proxyAuthorized(request, secret) {
  if (!secret) return true;
  const provided = request.headers.get('X-RapidAPI-Proxy-Secret');
  if (provided === null) return false;
  const [a, b] = await Promise.all([provided, secret].map((value) =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function resolvePublic(host, signal) {
  if (isPublicAddress(host)) return;
  const records = await Promise.all(['A', 'AAAA'].map(async (type) => {
    const resolver = new URL('https://cloudflare-dns.com/dns-query');
    resolver.searchParams.set('name', host);
    resolver.searchParams.set('type', type);
    const response = await fetch(resolver, {
      headers: { accept: 'application/dns-json' },
      redirect: 'manual',
      signal,
    });
    if (!response.ok) throw new PageError('Could not resolve the page host.');
    const reply = await response.json();
    if (reply.Status !== 0) throw new PageError('Could not resolve the page host.');
    return (reply.Answer ?? []).filter(({ type }) => type === 1 || type === 28).map(({ data }) => data);
  }));
  const addresses = records.flat();
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new PublicUrlError('The URL must resolve only to public addresses.');
  }
}

async function requestPublic({ url, host }, options) {
  await resolvePublic(host, options.signal);
  return { response: await fetch(url, options) };
}

async function readInput(request) {
  if (!request.body) throw new TypeError('Provide a JSON request body.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INPUT_BYTES) throw new RangeError('The request body exceeds 256 kB.');
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const input = JSON.parse(body + decoder.decode());
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') {
    throw new TypeError('Provide a URL string.');
  }
  const { url, previousHash, previousText, keywords = [] } = input;
  const previous = previousHash === undefined && previousText === undefined
    ? undefined
    : { contentHash: previousHash, pricingText: previousText };
  validateSnapshot(previous);
  if (!Array.isArray(keywords) || keywords.length > 50 || keywords.some((term) => typeof term !== 'string')) {
    throw new TypeError('Provide up to 50 keywords as strings.');
  }
  return { url, previous, keywords };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/health' && pathname !== '/v1/check') {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }
    if (!await proxyAuthorized(request, env.RAPIDAPI_PROXY_SECRET)) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const method = pathname === '/health' ? 'GET' : 'POST';
    if (request.method !== method) {
      return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { Allow: method } });
    }
    if (pathname === '/health') return Response.json({ status: 'ok' });
    let input;
    try {
      input = await readInput(request);
    } catch (error) {
      const message = error instanceof SyntaxError ? 'Provide a valid JSON request body.' : error.message;
      return Response.json({ error: message }, { status: error instanceof RangeError ? 413 : 400 });
    }
    const { url, previous, keywords } = input;
    try {
      const html = await fetchPublicHtml(url, requestPublic);
      return Response.json(await comparePricing(url, html, previous, keywords));
    } catch (error) {
      const message = error instanceof PageError ? error.message : 'Could not fetch or read the page.';
      return Response.json(failedCheck(url, message), { status: error instanceof PublicUrlError ? 400 : 502 });
    }
  },
};
