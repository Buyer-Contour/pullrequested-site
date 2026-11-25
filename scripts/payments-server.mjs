import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from 'mppx/server';
import { createPaymentHandlers } from '../lib/payments/handlers.mjs';
import { createMppRail, mppConfig, mppPath } from '../lib/payments/mpp.mjs';
import { paymentConfig } from '../lib/payments/runtime.mjs';

const mpp = mppConfig();
const config = paymentConfig(process.env, { allowMissingStripe: Boolean(mpp) });
const { origin } = config;
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || !origin.port) {
  throw new Error('Local server requires an explicit loopback URL and port, e.g. http://127.0.0.1:8787');
}
const stateDirectory = join('.payments-state', config.testMode ? 'test' : 'live');
const store = {
  async get(key) {
    try {
      return JSON.parse(await readFile(join(stateDirectory, key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  async add(key, value) {
    const path = join(stateDirectory, key);
    const staged = `${path}-${randomUUID()}`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(staged, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await link(staged, path);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
  },
};
const mppRail = mpp && createMppRail({ ...mpp, origin, store: Store.memory() });
const handlers = createPaymentHandlers({ ...config, store, mppRail });

createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    const init = { method: incoming.method, headers: incoming.headers };
    if (!['GET', 'HEAD'].includes(incoming.method) &&
        (Number(incoming.headers['content-length']) > 0 || incoming.headers['transfer-encoding'])) {
      init.body = Readable.toWeb(incoming);
      init.duplex = 'half';
    }
    let handler;
    if (url.pathname.startsWith('/q/')) {
      url.search = '';
      url.searchParams.set('quote', url.pathname.slice(3));
      handler = handlers.page;
    } else if (url.pathname === '/payment/submitted') {
      url.searchParams.set('result', 'submitted');
      handler = handlers.page;
    } else {
      handler = new Map([
        ['/api/pay', handlers.pay], ['/api/checkout', handlers.checkout], ['/api/stripe-webhook', handlers.webhook],
        ['/agent-pay-test', handlers.agentVerification], [mppPath, handlers.mpp],
      ]).get(url.pathname);
    }
    const response = handler ? await handler(new Request(url, init)) : new Response('Not found', { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(400);
    outgoing.end();
  }
}).listen(Number(origin.port), origin.hostname, () => console.log(`Quote payments listening at ${origin.origin}`));
