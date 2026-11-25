import { isVariant, variantOf } from '../lib/variants.mjs';

const statsObject = 'variant-stats';
const events = new Set(['card_open', 'mpp_challenge', 'quote_request', 'homepage_fetch', 'offer_fetch', 'llms_fetch']);

export function variantStats(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS variant_counts (
    day TEXT NOT NULL, event TEXT NOT NULL, variant TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (day, event, variant)
  )`);
  return {
    increment(event, variant) {
      if (!events.has(event) || !isVariant(variant)) return;
      const day = new Date().toISOString().slice(0, 10);
      sql.exec(`INSERT INTO variant_counts VALUES (?, ?, ?, 1)
        ON CONFLICT(day, event, variant) DO UPDATE SET count = count + 1`, day, event, variant);
    },
    list() {
      return sql.exec('SELECT day, event, variant, count FROM variant_counts ORDER BY day DESC, event, variant').toArray();
    },
  };
}

export async function recordVariant(env, event, url) {
  try {
    await env.PAYMENTS_STATE.getByName(statsObject).incrementVariant(event, variantOf(url));
  } catch {
    console.error('Variant counter unavailable');
  }
}

export async function readVariants(request, env) {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  }
  try {
    const counts = await env.PAYMENTS_STATE.getByName(statsObject).listVariants();
    return Response.json({ counts }, { headers });
  } catch {
    return Response.json({ error: 'variant_stats_unavailable' }, { status: 503, headers });
  }
}
