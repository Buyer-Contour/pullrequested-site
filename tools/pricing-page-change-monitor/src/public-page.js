import ipaddr from 'ipaddr.js';

const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class PageError extends Error {}
export class PublicUrlError extends PageError {}

export function isPublicAddress(address) {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

export function parsePublicUrl(value, base) {
  if (typeof value !== 'string' || value.length > 4096) throw new PublicUrlError('Enter a public HTTP(S) URL.');
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new PublicUrlError('Enter a public HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new PublicUrlError('Only HTTP(S) URLs without credentials or non-default ports are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '').toLowerCase();
  if (ipaddr.isValid(host) ? !isPublicAddress(host) :
    !host.includes('.') || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) {
    throw new PublicUrlError('The URL must point to a public host.');
  }
  url.hash = '';
  return { url, host };
}

async function readHtml(response) {
  if (!response.ok) throw new PageError(`The page returned HTTP ${response.status}.`);
  if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') ?? '')) {
    throw new PageError('The URL did not return an HTML page.');
  }
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    throw new PageError('The page is empty or exceeds the 3 MB response limit.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new PageError('The page exceeds the 3 MB response limit.');
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchPublicHtml(value, request) {
  let target = parsePublicUrl(value);
  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { response, close } = await request(target, {
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'PhantomPipePricingMonitor/1.0 (+mailto:dane@phantompipe.com)',
      },
    });
    try {
      if (!REDIRECTS.has(response.status)) return await readHtml(response);
      if (hop === MAX_REDIRECTS) throw new PageError('The page redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new PageError('The page returned a redirect without a destination.');
      target = parsePublicUrl(location, target.url);
    } finally {
      await response.body?.cancel().catch(() => {});
      await close?.();
    }
  }
}
