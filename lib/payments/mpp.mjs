import { Challenge, Credential, Errors, PaymentRequest, Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { Attribution, Proof } from 'mppx/tempo';
import { createPublicClient, http, isAddress, parseAbi, parseEventLogs, TransactionReceiptNotFoundError, zeroAddress } from 'viem';
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains';
import { Addresses } from 'viem/tempo';
import { PaymentError } from './quotes.mjs';

export const mppPath = '/api/mpp/pay';
export const tempoOusd = '0x20c0000000000000000000006a37da5c996874be';
const transactionHash = /^0x[0-9a-f]{64}$/i;
const transferWithMemo = parseAbi([
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
]);
const zonePortalPrefix = Addresses.zonePortal(0).slice(0, -16).toLowerCase();
const legacyZonePortals = [6, 7].map((id) => Addresses.zonePortal(id).toLowerCase());

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

export function createMppRail({ origin, recipient, secretKey, testnet, store, rpc }) {
  const realm = origin.hostname;
  const chain = testnet ? tempoModerato : tempoMainnet;
  rpc ??= createPublicClient({ chain, transport: http() });
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

  async function verifyExpiredPush({ challenge, payload, source }, quote) {
    const deadline = Math.min(Date.parse(challenge.expires), quote.expires_at * 1000);
    const amount = BigInt(quote.amount_cents) * 10_000n;
    const { request } = challenge;
    if (!Challenge.verify(challenge, { secretKey }) || challenge.method !== 'tempo' ||
        challenge.intent !== 'charge' || challenge.realm !== realm || !challenge.opaque ||
        PaymentRequest.deserialize(challenge.opaque)._mppx_scope !== terms(quote).scope ||
        request.currency?.toLowerCase() !== tempoOusd || request.recipient?.toLowerCase() !== recipient.toLowerCase() ||
        request.amount !== String(amount) || request.methodDetails?.chainId !== chain.id ||
        !Number.isFinite(deadline) || !transactionHash.test(payload.hash ?? '')) {
      throw new PaymentError(402, 'payment_not_verified');
    }
    const transaction = payload.hash.toLowerCase();
    let receipt;
    try {
      receipt = await rpc.getTransactionReceipt({ hash: transaction });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) throw new PaymentError(402, 'payment_not_verified');
      throw error;
    }
    const payer = source ? Proof.parsePkhSource(source) : { address: receipt.from, chainId: chain.id };
    const logs = parseEventLogs({ abi: transferWithMemo, logs: receipt.logs });
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== transaction ||
        payer?.chainId !== chain.id || payer.address.toLowerCase().startsWith(zonePortalPrefix) ||
        legacyZonePortals.includes(payer.address.toLowerCase()) ||
        !logs.some(({ address, args }) => address.toLowerCase() === tempoOusd &&
          args.from.toLowerCase() === payer.address.toLowerCase() &&
          args.to.toLowerCase() === recipient.toLowerCase() && args.amount === amount &&
          Attribution.verifyServer(args.memo, realm) && Attribution.verifyChallengeBinding(args.memo, challenge.id))) {
      throw new PaymentError(402, 'payment_not_verified');
    }
    const block = await rpc.getBlock({ blockHash: receipt.blockHash });
    if (block.timestampMillis == null) throw new PaymentError(502, 'mpp_settlement_unconfirmed');
    const timestamp = BigInt(block.timestampMillis);
    if (timestamp > BigInt(deadline)) throw new PaymentError(410, 'payment_confirmed_after_expiry');
    return {
      transaction,
      header: Receipt.serialize({ method: 'tempo', status: 'success', reference: transaction,
        timestamp: new Date(Number(timestamp)).toISOString() }),
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
    async verify(credential, quote, { expired } = {}) {
      const { scope, ...request } = terms(quote);
      let parsed;
      try {
        parsed = Credential.deserialize(credential);
      } catch {
        throw new PaymentError(expired ? 410 : 402, expired ? 'quote_expired' : 'payment_not_verified');
      }
      const push = parsed.payload.type === 'hash';
      if (expired) {
        if (!push) throw new PaymentError(410, 'quote_expired');
        return { push, settled: await verifyExpiredPush(parsed, quote) };
      }
      try {
        await payment.validateCredential(credential, { scope, request, realm });
        return { push, parsed };
      } catch (error) {
        if (push && error instanceof Errors.PaymentExpiredError) {
          return { push, settled: await verifyExpiredPush(parsed, quote) };
        }
        if (error instanceof Errors.CredentialReplayedError) throw new PaymentError(409, 'payment_replayed');
        if (error instanceof Errors.PaymentError && error.status < 500) throw new PaymentError(402, 'payment_not_verified');
        throw error;
      }
    },
    async settle(credential, quote, verified) {
      if (verified?.settled) return verified.settled;
      const { scope, ...request } = terms(quote);
      try {
        const receipt = await payment.broadcastCredential(credential, { scope, request, realm });
        if (!transactionHash.test(receipt.reference)) throw new PaymentError(502, 'mpp_settlement_unconfirmed');
        return { transaction: receipt.reference.toLowerCase(), header: Receipt.serialize(receipt) };
      } catch (error) {
        if (verified?.push && error instanceof Errors.PaymentExpiredError) {
          return verifyExpiredPush(verified.parsed, quote);
        }
        if (error instanceof Errors.CredentialReplayedError) throw new PaymentError(409, 'payment_replayed');
        if (error instanceof Errors.PaymentError) throw new PaymentError(502, 'mpp_settlement_unconfirmed');
        throw error;
      }
    },
  };
}
