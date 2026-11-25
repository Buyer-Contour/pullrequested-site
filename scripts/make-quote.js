const { parseArgs } = require('node:util');

async function main() {
  const { makeQuote } = await import('../lib/payments/quotes.mjs');
  const { stripeMinimumCents } = await import('../lib/payments/stripe-settings.mjs');
  const { values } = parseArgs({
    options: {
      'amount-cents': { type: 'string' },
      description: { type: 'string' },
      'expires-in': { type: 'string' },
    },
  });
  if (!process.env.PAYMENTS_ORIGIN) throw new Error('Set PAYMENTS_ORIGIN to the payment service origin');
  const { quote, token } = makeQuote({
    amount_cents: Number(values['amount-cents']),
    description: values.description,
    expiresIn: values['expires-in'] === undefined ? undefined : Number(values['expires-in']),
  }, process.env.QUOTE_SIGNING_SECRET);
  console.log(JSON.stringify({
    quote,
    quote_url: new URL(`/q/${token}`, process.env.PAYMENTS_ORIGIN).href,
    ...(quote.amount_cents >= stripeMinimumCents && {
      pay_url: new URL(`/api/pay?quote=${token}`, process.env.PAYMENTS_ORIGIN).href,
    }),
    mpp_url: new URL(`/api/mpp/pay?quote=${token}`, process.env.PAYMENTS_ORIGIN).href,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
