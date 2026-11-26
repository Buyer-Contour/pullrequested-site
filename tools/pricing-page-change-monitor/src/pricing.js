import { load } from 'cheerio/slim';
import { PageError } from './public-page.js';

const PRICE = /(?:[$€£]\s*\d[\d.,]*|\d[\d.,]*\s*[€£$]|\b(?:USD|EUR|GBP)\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:USD|EUR|GBP)\b)/gi;
const CADENCE = /(?:\/\s*(?:mo(?:nth)?|yr|year|seat|user)\b|\bper\s+(?:mo(?:nth)?|year|seat|user)\b|\bbilled\s+(?:monthly|annually|yearly)\b)/i;
const FREE_OR_CUSTOM = /^(?:free|custom(?: pricing)?|contact (?:us|sales)|talk to sales)$/i;
const PLAN_PRICE = /^custom(?: pricing)?$/i;
const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const BLOCK = /^(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|h[1-6]|header|li|main|ol|p|pre|section|table|td|th|tr|ul)$/;

function normalize(value) {
  return value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function linesOf(root) {
  const chunks = [];
  const walk = (node) => {
    if (node.type === 'text') chunks.push(node.data.replace(/\s+/g, ' '));
    if (node.type !== 'tag') return;
    const block = BLOCK.test(node.name) || node.name === 'br';
    if (block) chunks.push('\n');
    for (const child of node.children) walk(child);
    if (block) chunks.push('\n');
  };
  for (const node of root.toArray()) walk(node);
  return chunks.join('').split('\n').map(normalize).filter(Boolean);
}

function moneyIn(line) {
  return (line.match(PRICE) ?? []).map((match) => normalize(match).replace(/[.,]+$/, ''));
}

function isPricingSignal(line) {
  return moneyIn(line).length > 0 || CADENCE.test(line) || FREE_OR_CUSTOM.test(line);
}

export function extractPricing(html, keywords = []) {
  const $ = load(html);
  const title = normalize($('title').first().text() || $('h1').first().text());
  $('head,title,script,style,noscript,template,svg,[hidden],[aria-hidden="true"],[inert]').remove();
  $('[style]').filter((_, node) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test($(node).attr('style'))).remove();
  const body = $('body').first();
  if (!linesOf(body.length ? body : $.root().contents()).length) {
    throw new PageError('The page has no visible text.');
  }
  $('nav,footer').remove();
  const main = $('main,[role="main"]').first();
  const root = main.length ? main : body.length ? body : $.root().contents();
  const visibleLines = linesOf(root);
  const candidates = root.find(HEADING).toArray().flatMap((node) => {
    const heading = $(node);
    const headingLine = normalize(heading.text());
    const labelNode = heading.clone();
    labelNode.find('[class*="badge" i]').remove();
    const label = normalize(labelNode.text());
    if (!label || label.length > 60 || moneyIn(label).length || CADENCE.test(label) || node.name === 'h1') return [];
    for (const parent of heading.parents().toArray().slice(0, 5)) {
      const group = $(parent);
      if (parent === root[0] || group.find(HEADING).length !== 1) break;
      const lines = linesOf(group);
      const index = lines.indexOf(headingLine);
      const next = index >= 0 ? lines[index + 1] : undefined;
      if (next && (moneyIn(next).length || CADENCE.test(next) || PLAN_PRICE.test(next))) {
        return [{ label, headingLine }];
      }
    }
    return [];
  });
  const planNames = [...new Set(candidates.map(({ label }) => label))];
  const planLines = new Set(candidates.map(({ headingLine }) => headingLine));
  const terms = keywords.map((term) => normalize(term).toLowerCase()).filter(Boolean);
  const pricingLines = visibleLines.filter((line) => isPricingSignal(line) || planLines.has(line) ||
    terms.some((term) => line.toLowerCase().includes(term)));
  return {
    title,
    prices: [...new Set(visibleLines.flatMap(moneyIn))],
    planNames,
    pricingText: pricingLines.join('\n'),
  };
}

export async function hashText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function snapshotKey(url, keywords) {
  const keywordHash = await hashText(JSON.stringify([...keywords].sort()));
  return hashText(JSON.stringify([url, keywordHash]));
}

function missingLines(source, other) {
  const counts = new Map();
  for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1);
  return source.filter((line) => {
    const count = counts.get(line) ?? 0;
    if (count === 0) return true;
    counts.set(line, count - 1);
    return false;
  });
}

export function validateSnapshot(snapshot) {
  if (snapshot === undefined) return;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      (snapshot.contentHash === undefined && snapshot.pricingText === undefined) ||
      (snapshot.contentHash !== undefined && (typeof snapshot.contentHash !== 'string' || !/^[a-f\d]{64}$/i.test(snapshot.contentHash))) ||
      (snapshot.pricingText !== undefined && typeof snapshot.pricingText !== 'string')) {
    throw new TypeError('A previous snapshot must contain a SHA-256 contentHash and/or a pricingText string.');
  }
}

export async function comparePricing(url, html, previous, keywords) {
  const data = extractPricing(html, keywords);
  const contentHash = await hashText(data.pricingText);
  const previousText = previous?.pricingText;
  const previousHash = previous?.contentHash?.toLowerCase() ??
    (previousText !== undefined ? await hashText(previousText) : undefined);
  const changed = previousHash !== undefined && previousHash !== contentHash;
  const currentLines = data.pricingText.split('\n').filter(Boolean);
  const previousLines = previousText?.split('\n').filter(Boolean);
  return {
    url,
    checkedAt: new Date().toISOString(),
    ...data,
    contentHash,
    changed,
    addedLines: changed && previousLines ? missingLines(currentLines, previousLines) : [],
    removedLines: changed && previousLines ? missingLines(previousLines, currentLines) : [],
  };
}

export function failedCheck(url, error) {
  return {
    url,
    checkedAt: new Date().toISOString(),
    title: '',
    prices: [],
    planNames: [],
    pricingText: '',
    contentHash: null,
    changed: false,
    addedLines: [],
    removedLines: [],
    error,
  };
}
