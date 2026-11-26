import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const maxLifetime = 23 * 60 * 60;
const tokenPattern = /^[\w-]+\.[\w-]{43}$/;
const unixNow = () => Math.floor(Date.now() / 1000);
const products = new Map([
  ['evidence-brief-10', { amount_cents: 100, description: '20-row evidence brief (20 accepted rows at $0.05 each)' }],
]);
const microservices = new Map([
  ['icp-lead-list', { amount_cents: 1_400, description: 'ICP lead list' }],
  ['crm-dedupe-enrichment', { amount_cents: 2_800, description: 'CRM dedupe + enrichment' }],
  ['competitor-teardown', { amount_cents: 200, description: 'Competitor teardown' }],
  ['podcast-newsletter-placement', { amount_cents: 200, description: 'Podcast & newsletter placement list' }],
  ['local-business-review-replies', { amount_cents: 100, description: 'Local business review replies' }],
  ['agent-bill-audit', { amount_cents: 100, description: 'AI agent API & hosting bill audit' }],
  ['scraper-parser', { amount_cents: 200, description: 'Fixed-price scraper / parser job' }],
]);

export function microserviceFor(slug) {
  return microservices.get(slug);
}

export class PaymentError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function mac(secret, value) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Set QUOTE_SIGNING_SECRET to at least 32 bytes');
  return createHmac('sha256', secret).update(value).digest();
}

function validQuote(quote) {
  return typeof quote?.id === 'string' && /^[0-9a-f-]{36}$/.test(quote.id) &&
    quote.currency === 'usd' && Number.isInteger(quote.amount_cents) &&
    quote.amount_cents >= 1 && quote.amount_cents <= 99_999_999 &&
    typeof quote.description === 'string' && quote.description.trim() && quote.description.length <= 250 &&
    Number.isSafeInteger(quote.issued_at) && Number.isSafeInteger(quote.expires_at) &&
    quote.expires_at > quote.issued_at && quote.expires_at - quote.issued_at <= maxLifetime;
}

export function makeQuote({ amount_cents, description, expiresIn = maxLifetime }, secret, now = unixNow()) {
  return signQuote({ amount_cents, description, expiresIn }, secret, now);
}

function signQuote({ amount_cents, description, expiresIn = maxLifetime, service_slug }, secret, now) {
  const quote = {
    id: randomUUID(), amount_cents, currency: 'usd', description, issued_at: now, expires_at: now + expiresIn,
    ...(service_slug ? { service_slug } : {}),
  };
  if (!validQuote(quote)) throw new Error('Invalid quote: use USD cents (1–99999999), a 1–250 character description and a lifetime up to 23 hours');
  const body = Buffer.from(JSON.stringify(quote)).toString('base64url');
  return { quote, token: `${body}.${mac(secret, `quote:${body}`).toString('base64url')}` };
}

export function makeProductQuote(productId, secret, now, { checkout = false } = {}) {
  const service = checkout && microserviceFor(productId);
  if (service) return signQuote({ ...service, service_slug: productId }, secret, now);
  const product = products.get(productId);
  return product ? makeQuote(product, secret, now) : null;
}

export function readQuote(token, secret, { now = unixNow(), allowExpired = false } = {}) {
  const invalid = () => new PaymentError(400, 'invalid_quote');
  if (!token || token.length > 3000 || !tokenPattern.test(token)) throw invalid();
  const [body, signature] = token.split('.');
  const expected = mac(secret, `quote:${body}`).toString('base64url');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();

  let quote;
  try {
    quote = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    throw invalid();
  }
  if (!validQuote(quote) || quote.issued_at > now) throw invalid();
  if (!allowExpired && quote.expires_at <= now) throw new PaymentError(410, 'quote_expired');
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const nonce = mac(secret, `nonce:${fingerprint}`).toString('base64url');
  return { ...quote, fingerprint, nonce };
}
