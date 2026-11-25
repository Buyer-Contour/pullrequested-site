import { quoteStatus, submitQuote, wantsQuoteReceipt } from './quote-intake.mjs';
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
    if (request.method === 'POST' && quotePaths.has(pathname) && wantsQuoteReceipt(request)) {
      return submitQuote(request, env, (submission) => netlify(submission, { pathname: '/thanks/', search: url.search }));
    }
    if (pathname.startsWith('/quote/status/')) return quoteStatus(request, env, pathname);
    if (pathname === '/agent-pay-test' || (request.method === 'POST' && intakePaths.has(pathname))) {
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
    return new Response(response.body, { status: response.status, headers });
  },
};
