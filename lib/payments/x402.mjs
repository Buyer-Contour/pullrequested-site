import { createHash } from 'node:crypto';
import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { PaymentPayloadSchema } from '@x402/core/schemas';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { PaymentError } from './quotes.mjs';

export const x402Path = '/api/x402/pay';
export const baseSepolia = 'eip155:84532';
const base = 'eip155:8453';
const cdpUrl = 'https://api.cdp.coinbase.com/platform/v2/x402';
const address = /^0x[a-fA-F0-9]{40}$/;
const bytes32 = /^0x[a-fA-F0-9]{64}$/;
const discovery = declareDiscoveryExtension({
  input: { quote: '<signed-quote-token>' },
  inputSchema: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'], additionalProperties: false },
  output: {
    example: { quote_id: '3e829bc6-b36b-4a97-a364-2aa11025adc5', payment_id: `0x${'1'.repeat(64)}`, channel: 'x402', status: 'paid', paid_at: '2026-01-01T00:00:00.000Z' },
    schema: {
      type: 'object',
      properties: { quote_id: { type: 'string' }, payment_id: { type: 'string' }, channel: { const: 'x402' }, status: { const: 'paid' }, paid_at: { type: 'string', format: 'date-time' } },
      required: ['quote_id', 'payment_id', 'channel', 'status', 'paid_at'],
    },
  },
});

export function x402Config(env = process.env) {
  if (!env.X402_PAY_TO) return null;
  if (!address.test(env.X402_PAY_TO) || /^0x0{40}$/.test(env.X402_PAY_TO)) throw new Error('Set X402_PAY_TO to the receiving wallet address');
  const network = env.X402_NETWORK || baseSepolia;
  if (![baseSepolia, base].includes(network)) throw new Error('X402_NETWORK must be Base or Base Sepolia (CAIP-2)');
  const url = env.X402_FACILITATOR_URL || (network === base ? cdpUrl : 'https://x402.org/facilitator');
  const facilitatorUrl = new URL(url);
  if (facilitatorUrl.protocol !== 'https:' || facilitatorUrl.username || facilitatorUrl.password ||
      facilitatorUrl.search || facilitatorUrl.hash) throw new Error('Set X402_FACILITATOR_URL to an HTTPS facilitator base URL');
  let createAuthHeaders;
  if (network === base) {
    const { CDP_API_KEY_ID: apiKeyId, CDP_API_KEY_SECRET: apiKeySecret } = env;
    if (!apiKeyId || !apiKeySecret) throw new Error('Base mainnet requires CDP_API_KEY_ID and CDP_API_KEY_SECRET');
    createAuthHeaders = async () => Object.fromEntries(await Promise.all(['verify', 'settle', 'supported'].map(async (operation) => {
      const jwt = await generateJwt({
        apiKeyId, apiKeySecret, requestMethod: operation === 'supported' ? 'GET' : 'POST',
        requestHost: facilitatorUrl.host, requestPath: `${facilitatorUrl.pathname.replace(/\/$/, '')}/${operation}`,
      });
      return [operation, { Authorization: `Bearer ${jwt}` }];
    })));
  }
  const facilitator = new HTTPFacilitatorClient({ url, timeoutMs: 8000, createAuthHeaders });
  return { facilitator, network, payTo: env.X402_PAY_TO };
}

export function createX402Rail({ facilitator, network, payTo, origin }) {
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  const resource = {
    url: new URL(x402Path, origin).href,
    description: 'Pay an issued consulting quote using USDC on Base.',
    mimeType: 'application/json',
  };
  const transport = { method: 'GET', path: x402Path, routePattern: x402Path, adapter: { getPath: () => x402Path } };
  const extensions = server.enrichExtensions(discovery, transport);
  let initialization;
  async function requirements(quote) {
    initialization ??= server.initialize().catch((error) => { initialization = undefined; throw error; });
    await initialization;
    return server.buildPaymentRequirements({
      scheme: 'exact', network, payTo, price: quote.amount_cents / 100, maxTimeoutSeconds: 300,
    });
  }

  return {
    async challenge(quote, error = 'payment_required') {
      const body = await server.createPaymentRequiredResponse(await requirements(quote), resource, error, extensions, transport);
      return Response.json(body, { status: 402, headers: {
        'Payment-Required': encodePaymentRequiredHeader(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      } });
    },
    parse(header) {
      let parsed;
      try {
        if (!header || header.length > 16_384) return null;
        parsed = PaymentPayloadSchema.safeParse(decodePaymentSignatureHeader(header));
      } catch {
        return null;
      }
      if (!parsed.success || parsed.data.x402Version !== 2 || parsed.data.resource?.url !== resource.url) return null;
      const payload = { ...parsed.data, resource, extensions };
      const auth = payload.payload?.authorization;
      if (!address.test(auth?.from) || !bytes32.test(auth?.nonce)) return null;
      const proofId = createHash('sha256').update(`${network}:${payTo.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`).digest('hex');
      return { payload, proofId };
    },
    async verify(payment, quote) {
      const requirementsForPayment = server.findMatchingRequirements(await requirements(quote), payment.payload);
      const auth = payment.payload.payload.authorization;
      if (!requirementsForPayment || auth.value !== requirementsForPayment.amount ||
          typeof auth.to !== 'string' || auth.to.toLowerCase() !== payTo.toLowerCase()) return null;
      const result = await server.verifyPayment(payment.payload, requirementsForPayment, extensions, { request: transport });
      return result.isValid ? requirementsForPayment : null;
    },
    async settle(payment, requirementsForPayment) {
      const result = await server.settlePayment(payment.payload, requirementsForPayment, extensions, { request: transport });
      if (!result.success) throw new PaymentError(502, 'x402_settlement_unconfirmed');
      if (result.network !== network || !bytes32.test(result.transaction)) throw new PaymentError(502, 'x402_settlement_unconfirmed');
      return { transaction: result.transaction, header: encodePaymentResponseHeader(result) };
    },
  };
}
