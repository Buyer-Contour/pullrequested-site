import { withVariant } from '../lib/variants.mjs';
import { quoteStatus, submitQuote, wantsQuoteReceipt, wasQuoteForwarded } from './quote-intake.mjs';
import { readVariants, recordVariant } from './variant-stats.mjs';
export { QuoteReceipts } from './quote-intake.mjs';

const pages = new Map([
  ['/', '/index.html'],
  ['/quote', '/quote/index.html'],
  ['/quote/', '/quote/index.html'],
  ['/lab-notes', '/lab-notes/index.html'],
  ['/lab-notes/', '/lab-notes/index.html'],
  ['/thanks', '/thanks/index.html'],
  ['/thanks/', '/thanks/index.html'],
]);
const quotePaths = new Set(['/quote', '/quote/']);
const intakePaths = new Set([...quotePaths, '/thanks', '/thanks/']);
const discoveryPaths = new Map([
  ['/', 'homepage_fetch'],
  ['/offer.json', 'offer_fetch'],
  ['/llms.txt', 'llms_fetch'],
]);

function netlify(request, { pathname, search }) {
  const url = new URL('https://phantompipe.netlify.app');
  url.pathname = pathname;
  url.search = search;
  return fetch(new Request(url, request), { redirect: 'manual' });
}

function asset(request, env, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url, request));
}

function taggedPage(response, url) {
  const rewriter = new HTMLRewriter();
  if (url.pathname === '/') {
    rewriter.on('a[href="/quote"]', { element: (el) => el.setAttribute('href', withVariant('/quote', url)) });
  } else {
    rewriter.on('form[name="quote"]', { element: (el) => el.setAttribute('action', withVariant('/thanks/', url)) });
  }
  return rewriter.transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.phantompipe.com') {
      url.protocol = 'https:';
      url.host = 'phantompipe.com';
      url.port = '';
      return Response.redirect(url, 308);
    }
    const { pathname } = url;
    if (pathname === '/api/stats/variants') return readVariants(request, env);
    if (request.method === 'POST' && intakePaths.has(pathname)) {
      const forward = async (submission, target) => {
        const response = await netlify(submission, target);
        if (wasQuoteForwarded(response)) await recordVariant(env, 'quote_request', url);
        return response;
      };
      if (quotePaths.has(pathname) && wantsQuoteReceipt(request)) {
        return submitQuote(request, env, (submission) => forward(submission, { pathname: '/thanks/', search: url.search }));
      }
      return forward(request, url);
    }
    if (pathname.startsWith('/quote/status/')) return quoteStatus(request, env, pathname);
    if (pathname === '/agent-pay-test') {
      return netlify(request, url);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed.', { status: 405, headers: {
        Allow: intakePaths.has(pathname) ? 'GET, HEAD, POST' : 'GET, HEAD',
        'Cache-Control': 'no-store',
      } });
    }
    const response = await asset(request, env, pages.get(pathname) ?? pathname);
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    if (pathname === '/llms.txt') headers.set('Content-Type', 'text/plain; charset=utf-8');
    if (pathname === '/offer.json' || pathname === '/.well-known/x402.json') {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    if (pathname === '/offer.json') headers.set('Access-Control-Allow-Origin', '*');
    const tagged = request.method === 'GET' && url.searchParams.has('v');
    const event = discoveryPaths.get(pathname);
    if (tagged && event) await recordVariant(env, event, url);
    if (tagged && (event || quotePaths.has(pathname))) headers.set('Cache-Control', 'no-store');
    const output = new Response(response.body, { status: response.status, headers });
    return tagged && (pathname === '/' || quotePaths.has(pathname)) ? taggedPage(output, url) : output;
  },
};
