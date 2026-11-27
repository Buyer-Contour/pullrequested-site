import { withVariant } from '../lib/variants.mjs';
import { handleMcp } from './mcp.mjs';
import { quoteStatus, submitQuote, wantsQuoteReceipt, wasQuoteForwarded } from './quote-intake.mjs';
import { readVariants, recordVariant } from './variant-stats.mjs';
export { QuoteReceipts } from './quote-intake.mjs';

const pages = new Map([
  ['/', '/index.html'],
  ['/docs', '/docs/index.html'],
  ['/docs/', '/docs/index.html'],
  ['/quote', '/quote/index.html'],
  ['/quote/', '/quote/index.html'],
  ['/lab-notes', '/lab-notes/index.html'],
  ['/lab-notes/', '/lab-notes/index.html'],
  ['/services', '/services/index.html'],
  ['/services/', '/services/index.html'],
  ['/agent-bill-audit', '/agent-bill-audit/index.html'],
  ['/agent-bill-audit/', '/agent-bill-audit/index.html'],
  ['/scraper-parser', '/scraper-parser/index.html'],
  ['/scraper-parser/', '/scraper-parser/index.html'],
  ['/receipts', '/receipts/index.html'],
  ['/receipts/', '/receipts/index.html'],
  ['/samples', '/receipts/index.html'],
  ['/samples/', '/receipts/index.html'],
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

function asset(request, env, path, personalized) {
  const url = new URL(request.url);
  url.pathname = path;
  const assetRequest = new Request(url, request);
  if (personalized) {
    assetRequest.headers.delete('If-None-Match');
    assetRequest.headers.delete('If-Modified-Since');
  }
  return env.ASSETS.fetch(assetRequest);
}

function taggedPage(response, url) {
  const rewriter = new HTMLRewriter();
  if (url.pathname === '/') {
    for (const path of ['/quote', '/offer.json', '/llms.txt', '/services/']) {
      rewriter.on(`a[href="${path}"]`, { element: (el) => el.setAttribute('href', withVariant(path, url)) });
    }
  } else {
    rewriter.on('form[name="quote"]', { element: (el) => el.setAttribute('action', withVariant('/thanks/', url)) });
  }
  return rewriter.transform(response);
}

async function taggedDiscovery(response, headers, url) {
  if (url.pathname === '/offer.json') {
    const offer = await response.json();
    const payment = offer.evidence_brief.marketplace_payment;
    for (const [section, key] of [
      [offer.quote_request, 'url'], [offer.contact, 'url'], [payment, 'mpp_url'],
      [offer.fixed_price_services, 'url'], [offer.fixed_price_services.intake, 'url'],
    ]) {
      if (section?.[key]) section[key] = withVariant(section[key], url);
    }
    return Response.json(offer, { status: response.status, headers });
  }
  const text = await response.text();
  const links = /https:\/\/phantompipe\.com\/(?:quote\/?|offer\.json|services\/|agent-bill-audit\/|scraper-parser\/|api\/mpp\/pay\?product=evidence-brief-10)?(?=[\s)]|$)/g;
  return new Response(text.replace(links, (link) => withVariant(link, url)), { status: response.status, headers });
}

const site = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.phantompipe.com') {
      url.protocol = 'https:';
      url.host = 'phantompipe.com';
      url.port = '';
      return Response.redirect(url, 308);
    }
    const { pathname } = url;
    if (pathname === '/mcp') {
      return handleMcp(request, (path, init) => site.fetch(new Request(new URL(path, url), init), env));
    }
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
    const event = discoveryPaths.get(pathname);
    const personalized = url.searchParams.has('v') && (event || quotePaths.has(pathname));
    const response = await asset(request, env, pages.get(pathname) ?? pathname, personalized);
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    if (pathname === '/llms.txt' || pathname === '/.well-known/mcp-registry-auth') {
      headers.set('Content-Type', 'text/plain; charset=utf-8');
    }
    if (['/offer.json', '/openapi.json', '/.well-known/x402.json', '/.well-known/mcp.json'].includes(pathname)) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    if (pathname === '/offer.json') headers.set('Access-Control-Allow-Origin', '*');
    if (personalized) {
      headers.set('Cache-Control', 'no-store');
      headers.delete('ETag');
      headers.delete('Last-Modified');
      headers.delete('Content-Length');
      if (request.method === 'HEAD') return new Response(null, { status: response.status, headers });
      if (event) await recordVariant(env, event, url);
      if (pathname === '/offer.json' || pathname === '/llms.txt') return taggedDiscovery(response, headers, url);
      return taggedPage(new Response(response.body, { status: response.status, headers }), url);
    }
    return new Response(response.body, { status: response.status, headers });
  },
};

export default site;
