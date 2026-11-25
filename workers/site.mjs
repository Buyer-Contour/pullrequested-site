const pages = new Map([
  ['/', '/index.html'],
  ['/quote', '/quote/index.html'],
  ['/quote/', '/quote/index.html'],
  ['/thanks', '/thanks/index.html'],
  ['/thanks/', '/thanks/index.html'],
]);
const serviceIds = new Set(['pipeline-research', 'gtm-data-ops', 'outbound-systems', 'gtm-automation', 'not-sure']);
const intakePaths = new Set(['/quote', '/quote/', '/thanks', '/thanks/']);
const maxFormBytes = 16 * 1024;

function error(status, message, headers = {}) {
  return new Response(message, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

async function readForm(request) {
  if (Number(request.headers.get('Content-Length')) > maxFormBytes) return null;
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxFormBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  return new URLSearchParams(text);
}

function asset(request, env, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url, request));
}

async function accepted(request, env, pathname) {
  if (pathname === '/thanks' || pathname === '/thanks/') {
    return new Response(null, { status: 303, headers: { Location: '/thanks/', 'Cache-Control': 'no-store' } });
  }
  const page = await asset(new Request(request.url), env, '/thanks/index.html');
  const headers = new Headers(page.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(page.body, { status: page.status, headers });
}

async function submitQuote(request, env, pathname) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return error(415, 'Use application/x-www-form-urlencoded.');
  }
  const form = await readForm(request);
  if (!form) return error(413, 'Quote request is too large.');
  if (form.get('form-name') !== 'quote') return error(400, 'Invalid form name.');
  if (form.getAll('bot-field').some(value => value.trim())) return accepted(request, env, pathname);

  const [name, email, company, service, brief] = ['name', 'email', 'company', 'service', 'brief']
    .map(field => form.get(field)?.trim() ?? '');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !serviceIds.has(service) || !brief) {
    return error(400, 'Provide your name, a valid reply-to email, a service, and a brief.');
  }
  if (!env.AGENTMAIL_API_KEY || !env.QUOTE_INBOX) return error(503, 'Quote delivery is temporarily unavailable.');

  try {
    const inbox = encodeURIComponent(env.QUOTE_INBOX);
    const result = await fetch(`https://api.agentmail.to/v0/inboxes/${inbox}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: [env.QUOTE_INBOX],
        reply_to: [email],
        subject: 'New Phantom Pipe quote request',
        text: `Name: ${name}\nEmail: ${email}\nCompany or agent: ${company}\nService: ${service}\n\n${brief}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) return error(503, 'Quote delivery is temporarily unavailable.');
  } catch {
    return error(503, 'Quote delivery is temporarily unavailable.');
  }
  return accepted(request, env, pathname);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && intakePaths.has(pathname)) return submitQuote(request, env, pathname);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return error(405, 'Method not allowed.', { Allow: intakePaths.has(pathname) ? 'GET, HEAD, POST' : 'GET, HEAD' });
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
