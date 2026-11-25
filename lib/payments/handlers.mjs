import { createHash } from 'node:crypto';
import { PaymentError, readQuote } from './quotes.mjs';
import { checkoutWebhookEvents, stripeSource } from './stripe-settings.mjs';
import { agentVerificationPage } from './agent-verification-page.mjs';
import { agentVerificationDescription, checkoutVerificationDescription, verificationAmount } from './live-verification.mjs';

const sptApiVersion = '2026-09-30.preview';
const noCache = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const paymentIntentPattern = /^pi_[a-zA-Z0-9]{1,64}$/;
const paymentMethodPattern = /^pm_[a-zA-Z0-9]{1,64}$/;
const paymentMethodDocs = 'https://docs.stripe.com/js/payment_methods/create_payment_method';
const escape = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const json = (data, status = 200) => Response.json(data, { status, headers: noCache });
const redirect = (location) => new Response(null, { status: 303, headers: { ...noCache, Location: location } });
const html = (body) => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quote payment | pullrequested.com</title><main>${body}</main></html>`,
  { headers: { ...noCache, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'" } },
);

function fail(status, code) {
  throw new PaymentError(status, code);
}

async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'expected_json');
  }
  let body;
  try {
    const text = await request.text();
    if (text.length <= 2048) body = JSON.parse(text);
  } catch {
    fail(400, 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json');
  return body;
}

export function createPaymentHandlers({ stripe, store, origin, testMode, publishableKey, signingSecret, webhookSecret, mppRail, now = () => Math.floor(Date.now() / 1000) }) {
  function safe(methods, handler) {
    return async (request) => {
      if (!methods.includes(request.method)) {
        return new Response('Method not allowed', { status: 405, headers: { ...noCache, Allow: methods.join(', ') } });
      }
      try {
        return await handler(request, new URL(request.url));
      } catch (error) {
        if (error instanceof PaymentError) return json({ error: error.message }, error.status);
        if (error.type === 'StripeCardError') return json({ error: 'payment_declined' }, 402);
        console.error('Quote payment operation failed:', error.type ?? error.name);
        return json({ error: 'payment_service_unavailable' }, 502);
      }
    };
  }

  function verify(token, allowExpired = false) {
    return readQuote(token, signingSecret, { now: now(), allowExpired });
  }

  function metadata(quote) {
    return { source: stripeSource, quote_id: quote.id, quote_fingerprint: quote.fingerprint };
  }

  async function reserve(quote, channel, credential = {}, prefix = '') {
    const key = `${prefix}reservation/${quote.id}`;
    const reservation = { channel, ...metadata(quote), amount: quote.amount_cents, currency: quote.currency, ...credential };
    if (await store.add(key, reservation)) return;
    const existing = await store.get(key);
    if (existing?.quote_fingerprint !== quote.fingerprint || existing.channel !== channel) {
      fail(409, 'quote_reserved_for_another_payment');
    }
    if (existing.credential_hash !== reservation.credential_hash) {
      fail(409, 'quote_reserved_for_another_credential');
    }
  }

  function receipt(quoteId, paymentId, channel) {
    return { quote_id: quoteId, payment_id: paymentId, channel, status: 'paid', paid_at: new Date(now() * 1000).toISOString() };
  }

  function matches(intent, quote) {
    return intent?.status === 'succeeded' && intent.livemode === !testMode &&
      intent.amount === quote.amount_cents && intent.amount_received === quote.amount_cents &&
      intent.currency === quote.currency && intent.metadata?.quote_id === quote.id &&
      intent.metadata.quote_fingerprint === quote.fingerprint && intent.metadata.nonce === quote.nonce &&
      intent.metadata.machine_payment === 'true' && intent.metadata.source === stripeSource;
  }

  async function verifyPaymentMethod(id, quote) {
    let method;
    try {
      method = await stripe.paymentMethods.retrieve(id);
    } catch (error) {
      if (error.code === 'resource_missing') fail(402, 'payment_method_not_found');
      throw error;
    }
    if (method.customer !== null) fail(402, 'payment_method_attached_to_customer');
    if (method.type !== 'card' || method.livemode !== !testMode ||
        !Number.isSafeInteger(method.created) || method.created < quote.issued_at) {
      fail(402, 'payment_method_not_eligible');
    }
  }

  const page = safe(['GET'], async (_request, url) => {
    if (url.searchParams.get('result') === 'submitted') {
      return html('<h1>Returned from Stripe Checkout</h1><p>We’ll confirm your payment with Stripe. Please keep your Stripe receipt.</p>');
    }
    const token = url.searchParams.get('quote');
    const quote = verify(token);
    const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(quote.amount_cents / 100);
    return html(`<h1>Pay your pullrequested.com quote</h1><p>${escape(quote.description)}</p><p>Total: ${amount} USD</p><form method="post" action="/api/checkout?quote=${escape(token)}"><button>Continue to Stripe Checkout</button></form>`);
  });

  const agentVerification = safe(['GET'], async (_request, url) => {
    const quote = verify(url.searchParams.get('quote'));
    if (testMode || !publishableKey || quote.description !== agentVerificationDescription || quote.amount_cents !== verificationAmount) {
      fail(404, 'verification_quote_not_found');
    }
    return agentVerificationPage();
  });

  const checkout = safe(['GET', 'POST'], async (_request, url) => {
    const token = url.searchParams.get('quote');
    const quote = verify(token);
    if (await store.get(`paid/${quote.id}`)) fail(409, 'quote_already_paid');
    const existing = await store.get(`checkout/${quote.id}`);
    if (existing?.quote_fingerprint === quote.fingerprint) return redirect(existing.url);
    if (quote.expires_at - now() < 31 * 60) fail(410, 'quote_too_close_to_expiry_for_checkout');
    await reserve(quote, 'checkout');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(!testMode && quote.description === checkoutVerificationDescription && quote.amount_cents === verificationAmount
        ? { allowed_payment_method_types: ['card', 'link'] }
        : {}),
      client_reference_id: quote.id,
      expires_at: quote.expires_at,
      line_items: [{ quantity: 1, price_data: {
        currency: quote.currency, unit_amount: quote.amount_cents, product_data: { name: quote.description, metadata: { source: stripeSource } },
      } }],
      metadata: metadata(quote),
      payment_intent_data: { metadata: metadata(quote) },
      success_url: new URL('/payment/submitted', origin).href,
      cancel_url: new URL(`/q/${token}`, origin).href,
    }, { idempotencyKey: `quote-checkout-${quote.id}` });
    if (!session.url) fail(502, 'checkout_unavailable');
    await store.add(`checkout/${quote.id}`, { ...metadata(quote), url: session.url });
    return redirect(session.url);
  });

  const pay = safe(['GET', 'POST'], async (request, url) => {
    const proof = request.headers.get('X-PAYMENT');
    const quote = verify(url.searchParams.get('quote'), true);
    const paidKey = `paid/${quote.id}`;
    if (await store.get(paidKey)) fail(409, proof === null ? 'quote_already_paid' : 'payment_replayed');

    if (proof !== null) {
      if (!paymentIntentPattern.test(proof)) fail(400, 'invalid_payment_proof');
      const reservation = await store.get(`reservation/${quote.id}`);
      if (reservation?.channel !== 'agent' || reservation.quote_fingerprint !== quote.fingerprint) {
        fail(402, 'payment_not_verified');
      }
      let intent;
      try {
        intent = await stripe.paymentIntents.retrieve(proof);
      } catch (error) {
        if (error.code === 'resource_missing') fail(402, 'payment_not_verified');
        throw error;
      }
      if (!matches(intent, quote)) fail(402, 'payment_not_verified');
      const result = receipt(quote.id, intent.id, 'agent');
      if (!await store.add(paidKey, result)) fail(409, 'payment_replayed');
      return json(result);
    }

    if (quote.expires_at <= now()) fail(410, 'quote_expired');
    if (request.method === 'GET' || request.body === null) {
      return json({
        protocol: 'quote-pay-v1', quote_id: quote.id, amount_cents: quote.amount_cents, currency: quote.currency,
        nonce: quote.nonce, expires_at: quote.expires_at,
        payment: { method: 'POST', url: `/api/pay?quote=${url.searchParams.get('quote')}`,
          fields: { nonce: 'nonce above', shared_payment_token: 'Stripe spt_ token',
            ...(publishableKey && { payment_method: 'Fresh, unattached Stripe card pm_ ID' }) },
          ...(publishableKey && { stripe: {
            publishable_key: publishableKey,
            tokenize: { sdk: 'Stripe.js', method: 'stripe.createPaymentMethod', url: paymentMethodDocs,
              instructions: 'Use this publishable key and Stripe Elements to create a new card PaymentMethod for this quote. Send its ID as payment_method instead of shared_payment_token; never send raw card data to this endpoint.' },
          } }),
          ...(testMode && { test_only_alternative: { payment_method: 'pm_card_visa' } }) },
        redeem: { method: 'GET', header: 'X-PAYMENT', value: 'payment_intent_id from POST response' },
      }, 402);
    }

    const body = await readBody(request);
    if (body.nonce !== quote.nonce) fail(402, 'invalid_payment_nonce');
    const spt = body.shared_payment_token;
    const pm = body.payment_method;
    const useSpt = pm === undefined && typeof spt === 'string' && /^spt_[a-zA-Z0-9]{1,200}$/.test(spt);
    const useTestCard = testMode && pm === 'pm_card_visa';
    const usePm = spt === undefined && (useTestCard || (publishableKey && typeof pm === 'string' && paymentMethodPattern.test(pm)));
    if (!useSpt && !usePm) fail(400, 'invalid_payment_credential');
    if (usePm && !useTestCard) await verifyPaymentMethod(pm, quote);
    if (quote.expires_at <= now()) fail(410, 'quote_expired');
    const credential_hash = createHash('sha256').update(useSpt ? spt : pm).digest('hex');
    await reserve(quote, 'agent', { credential_hash });
    if (quote.expires_at <= now()) fail(410, 'quote_expired');
    const intent = await stripe.paymentIntents.create({
      amount: quote.amount_cents,
      currency: quote.currency,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { ...metadata(quote), nonce: quote.nonce, machine_payment: 'true' },
      ...(useSpt ? { payment_method_data: { shared_payment_granted_token: spt } } : { payment_method: pm }),
    }, { idempotencyKey: `quote-agent-${quote.id}`, ...(useSpt && { apiVersion: sptApiVersion }) });
    if (!matches(intent, quote)) fail(402, 'payment_not_completed');
    return json({ payment_intent_id: intent.id });
  });

  const mpp = safe(['GET'], async (request, url) => {
    if (!mppRail) fail(503, 'mpp_not_configured');
    const authorization = request.headers.get('Authorization');
    const hasCredential = /^Payment(?:\s|$)/i.test(authorization ?? '');
    const quote = verify(url.searchParams.get('quote'), hasCredential);
    const prefix = mppRail.testnet ? 'mpp-testnet/' : '';
    const paidKey = `${prefix}paid/${quote.id}`;
    if (await store.get(paidKey)) fail(409, hasCredential ? 'payment_replayed' : 'quote_already_paid');
    if (!hasCredential) {
      if (await store.get(`${prefix}reservation/${quote.id}`)) fail(409, 'quote_reserved_for_another_payment');
      return mppRail.challenge(request, quote);
    }
    if (authorization.length > 16_384) fail(400, 'invalid_payment_credential');
    const proofId = createHash('sha256').update(authorization).digest('hex');
    const settlementKey = `${prefix}mpp-settlement/${proofId}`;
    const recordPaid = async ({ paid, header }) => {
      if (!await store.add(paidKey, paid)) fail(409, 'payment_replayed');
      return Response.json(paid, { headers: { ...noCache, 'Payment-Receipt': header } });
    };
    const previous = await store.get(settlementKey);
    if (previous) {
      if (previous.quote_fingerprint !== quote.fingerprint) fail(409, 'payment_replayed');
      return recordPaid(previous);
    }
    const verified = await mppRail.verify(authorization, quote, { expired: quote.expires_at <= now() });
    if (!verified?.push && quote.expires_at <= now()) fail(410, 'quote_expired');
    await reserve(quote, 'mpp', { credential_hash: proofId }, prefix);
    if (!verified?.push && quote.expires_at <= now()) fail(410, 'quote_expired');
    const { transaction, header } = await mppRail.settle(authorization, quote, verified);
    const transactionKey = `${prefix}mpp-transaction/${transaction}`;
    if (!await store.add(transactionKey, { quote_fingerprint: quote.fingerprint }) &&
        (await store.get(transactionKey))?.quote_fingerprint !== quote.fingerprint) {
      fail(409, 'payment_replayed');
    }
    const settled = { quote_fingerprint: quote.fingerprint, paid: receipt(quote.id, transaction, 'mpp'), header };
    const [, saved] = await Promise.allSettled([
      store.add(settlementKey, settled),
      recordPaid(settled),
    ]);
    if (saved.status === 'rejected') throw saved.reason;
    return saved.value;
  });

  const webhook = safe(['POST'], async (request) => {
    if (!webhookSecret) fail(503, 'webhook_not_configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(await request.text(), request.headers.get('Stripe-Signature'), webhookSecret);
    } catch {
      fail(400, 'invalid_webhook_signature');
    }
    if (event.livemode !== !testMode || !checkoutWebhookEvents.includes(event.type)) {
      return json({ received: true });
    }
    const session = event.data.object;
    if (session.metadata?.source !== stripeSource) return json({ received: true });
    const quoteId = session.metadata?.quote_id;
    if (session.mode !== 'payment' || session.payment_status !== 'paid' || !/^[0-9a-f-]{36}$/.test(quoteId)) {
      return json({ received: true });
    }
    const reservation = await store.get(`reservation/${quoteId}`);
    if (reservation?.channel !== 'checkout' || reservation.quote_fingerprint !== session.metadata.quote_fingerprint ||
        reservation.amount !== session.amount_total || reservation.currency !== session.currency) {
      return json({ received: true });
    }
    await store.add(`paid/${quoteId}`, receipt(quoteId, session.id, 'checkout'));
    return json({ received: true });
  });

  return { page, checkout, pay, webhook, mpp, agentVerification };
}
