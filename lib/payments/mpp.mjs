import { Errors, Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { isAddress, zeroAddress } from 'viem';
import { PaymentError } from './quotes.mjs';

export const mppPath = '/api/mpp/pay';
export const tempoOusd = '0x20c0000000000000000000006a37da5c996874be';
const transactionHash = /^0x[0-9a-f]{64}$/i;

export function mppConfig(env = process.env) {
  if (!env.MPP_PAY_TO || !env.MPP_NETWORK) return null;
  if (!isAddress(env.MPP_PAY_TO) || env.MPP_PAY_TO === zeroAddress) {
    throw new Error('Set MPP_PAY_TO to the Tempo receiving wallet address');
  }
  if (!['tempo', 'moderato'].includes(env.MPP_NETWORK)) throw new Error('Set MPP_NETWORK to tempo or moderato');
  if (!env.MPP_SECRET_KEY || Buffer.byteLength(env.MPP_SECRET_KEY) < 32) {
    throw new Error('Set MPP_SECRET_KEY to at least 32 bytes');
  }
  return { recipient: env.MPP_PAY_TO, testnet: env.MPP_NETWORK === 'moderato', secretKey: env.MPP_SECRET_KEY };
}

export function mppBlobsStore(blobs) {
  async function update(key, fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await blobs.getWithMetadata(key, { type: 'json' });
      const change = fn(entry?.data ?? null);
      if (change.op === 'noop') return change.result;
      if (entry && !entry.etag) throw new Error('Missing MPP blob ETag');
      const condition = entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true };
      const value = change.op === 'set' ? change.value : null;
      if ((await blobs.setJSON(key, value, condition)).modified) return change.result;
    }
    throw new Error('MPP store update conflicted');
  }
  return {
    get: (key) => blobs.get(key, { type: 'json' }),
    put: async (key, value) => { await blobs.setJSON(key, value); },
    delete: (key) => blobs.delete(key),
    update,
  };
}

export function createMppRail({ origin, recipient, secretKey, testnet, store }) {
  const realm = origin.hostname;
  const payment = Mppx.create({
    realm, secretKey,
    methods: [tempo.charge({ recipient, testnet, currencies: [tempoOusd], machineTokenEnabled: false, store })],
  });

  function terms(quote) {
    return {
      amount: (quote.amount_cents / 100).toFixed(2),
      scope: `${mppPath}:${quote.fingerprint}`,
    };
  }

  return {
    testnet,
    async challenge(request, quote) {
      const result = await payment.charge({
        ...terms(quote),
        expires: new Date(Math.min(quote.expires_at * 1000, Date.now() + 300_000)).toISOString(),
      })(request);
      if (result.status !== 402) throw new PaymentError(502, 'mpp_challenge_unavailable');
      result.challenge.headers.set('Cache-Control', 'no-store');
      result.challenge.headers.set('Referrer-Policy', 'no-referrer');
      return result.challenge;
    },
    async verify(credential, quote) {
      const { scope, ...request } = terms(quote);
      try {
        await payment.validateCredential(credential, { scope, request, realm });
      } catch (error) {
        if (error instanceof Errors.CredentialReplayedError) throw new PaymentError(409, 'payment_replayed');
        if (error instanceof Errors.PaymentError && error.status < 500) throw new PaymentError(402, 'payment_not_verified');
        throw error;
      }
    },
    async settle(credential, quote) {
      const { scope, ...request } = terms(quote);
      try {
        const receipt = await payment.broadcastCredential(credential, { scope, request, realm });
        if (!transactionHash.test(receipt.reference)) throw new PaymentError(502, 'mpp_settlement_unconfirmed');
        return { transaction: receipt.reference.toLowerCase(), header: Receipt.serialize(receipt) };
      } catch (error) {
        if (error instanceof Errors.CredentialReplayedError) throw new PaymentError(409, 'payment_replayed');
        if (error instanceof Errors.PaymentError) throw new PaymentError(502, 'mpp_settlement_unconfirmed');
        throw error;
      }
    },
  };
}
