import { randomBytes } from 'node:crypto';

export function agentVerificationPage() {
  const nonce = randomBytes(18).toString('base64url');
  return new Response(`<!doctype html><html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent payment verification | pullrequested.com</title>
<main>
  <h1>Verify a $1.00 agent payment</h1>
  <p>This is a real Stripe charge. The operator will refund it after verification.</p>
  <form id="payment">
    <h2>Card details</h2>
    <div id="card"></div>
    <p><button id="pay" disabled>Pay $1.00 USD</button></p>
  </form>
  <p id="status" role="status">Loading secure card entry…</p>
</main>
<script src="https://js.stripe.com/v3/"></script>
<script nonce="${nonce}">
  (async () => {
    const status = document.getElementById('status');
    const button = document.getElementById('pay');
    const quote = new URLSearchParams(location.search).get('quote');
    const url = '/api/pay?' + new URLSearchParams({ quote });
    try {
      const response = await fetch(url);
      if (response.status !== 402) throw new Error();
      const challenge = await response.json();
      const key = challenge.payment.stripe.publishable_key;
      if (!key.startsWith('pk_live_') || challenge.currency !== 'usd' || challenge.amount_cents !== 100) throw new Error();
      const stripe = Stripe(key);
      const card = stripe.elements().create('card');
      card.mount('#card');
      document.getElementById('payment').addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        status.textContent = 'Verifying your payment…';
        try {
          const result = await stripe.createPaymentMethod({ type: 'card', card });
          if (result.error) {
            status.textContent = result.error.message;
            button.disabled = false;
            return;
          }
          const payment = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: challenge.nonce, payment_method: result.paymentMethod.id }),
          });
          if (!payment.ok) throw new Error();
          const { payment_intent_id: id } = await payment.json();
          const headers = { 'X-PAYMENT': id };
          const receipt = await fetch(url, { headers });
          if (!receipt.ok) throw new Error();
          const replay = await fetch(url, { headers });
          if (replay.status !== 409 || (await replay.json()).error !== 'payment_replayed') throw new Error();
          status.textContent = 'Payment received. The replay was rejected (HTTP 409). The operator will refund this charge.';
        } catch {
          status.textContent = 'Verification did not finish. Please do not pay again; contact the operator to check the charge.';
        }
      });
      status.textContent = 'Ready for card entry.';
      button.disabled = false;
    } catch {
      status.textContent = 'This verification link is unavailable. Contact the operator.';
    }
  })();
</script></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com https://r.stripe.com https://m.stripe.network; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  } });
}
