import assert from 'node:assert/strict';
import { Challenge, Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { createPublicClient, erc20Abi, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { mppPath, tempoOusd } from '../lib/payments/mpp.mjs';
import { makeQuote } from '../lib/payments/quotes.mjs';

const key = process.env.MPP_TEST_PAYER_PRIVATE_KEY;
assert.ok(/^0x[0-9a-f]{64}$/i.test(key), 'Set MPP_TEST_PAYER_PRIVATE_KEY from a Moderato test wallet');
const payer = privateKeyToAccount(key);
const recipient = process.env.MPP_PAY_TO?.toLowerCase();
assert.ok(/^0x[0-9a-f]{40}$/.test(recipient), 'Set MPP_PAY_TO to the expected Tempo recipient');
assert.notEqual(payer.address.toLowerCase(), recipient);
const { quote, token } = makeQuote({ amount_cents: 50, description: 'Moderato MPP verification' }, process.env.QUOTE_SIGNING_SECRET);
const url = new URL(`${mppPath}?quote=${token}`, process.env.PAYMENTS_ORIGIN);
const initial = await fetch(url, { redirect: 'error' });
assert.equal(initial.status, 402);
const challenge = Challenge.fromResponse(initial);
assert.equal(challenge.method, 'tempo');
assert.equal(challenge.intent, 'charge');
assert.equal(challenge.request.recipient.toLowerCase(), recipient);
assert.equal(challenge.request.currency.toLowerCase(), tempoOusd);
assert.equal(challenge.request.amount, '500000');
assert.equal(challenge.request.methodDetails.chainId, tempoModerato.id);
const mode = process.env.MPP_TEST_MODE ?? 'pull';
assert.ok(mode === 'push' || mode === 'pull');
const client = Mppx.create({ polyfill: false, methods: [tempo.charge({
  account: payer, expectedChainId: tempoModerato.id, expectedRecipients: [recipient], feeToken: tempoOusd, mode,
  currencies: [tempoOusd], decimals: 6, maxAmount: '0.50',
})] });
const authorization = await client.createCredential(initial);
const options = { headers: { Authorization: authorization }, redirect: 'error' };
const response = await fetch(url, options);
assert.equal(response.status, 200, `MPP settlement returned HTTP ${response.status}`);
const body = await response.json();
const receipt = Receipt.fromResponse(response);
assert.equal(receipt.method, 'tempo');
assert.equal(body.quote_id, quote.id);
assert.equal(body.payment_id, receipt.reference);
const rpc = createPublicClient({ chain: tempoModerato, transport: http() });
const onChain = await rpc.getTransactionReceipt({ hash: receipt.reference });
assert.equal(onChain.status, 'success');
const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: onChain.logs });
assert.ok(transfers.some(({ address, args }) => address.toLowerCase() === tempoOusd &&
  args.from.toLowerCase() === payer.address.toLowerCase() && args.to.toLowerCase() === recipient && args.value === 500000n));
const replay = await fetch(url, options);
assert.equal(replay.status, 409);
assert.equal((await replay.json()).error, 'payment_replayed');
console.log(`Moderato MPP (${mode}): 0.50 OUSD settled in ${receipt.reference}; replay rejected (HTTP 409).`);
