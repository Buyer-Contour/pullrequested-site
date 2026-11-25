const { cpSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

function buildSurge({ siteUrl, recipient, output }) {
  const site = new URL(siteUrl);
  const source = resolve(__dirname, '../public');
  const offer = JSON.parse(readFileSync(join(source, 'offer.json'), 'utf8'));
  const email = recipient ?? offer.contact.email;
  if (!/^https:\/\/[a-z0-9-]+\.surge\.sh\/$/i.test(site.href)) {
    throw new Error('SURGE_SITE_URL must be an HTTPS surge.sh site URL');
  }
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email || '')) {
    throw new Error('QUOTE_RECIPIENT or contact.email must be an email address');
  }

  const endpoint = 'https://formsubmit.co';
  const address = encodeURIComponent(email).replace('%40', '@');
  const inboxForm = endpoint + '/' + address;
  const inboxJson = endpoint + '/ajax/' + address;
  const quoteUrl = new URL('/quote/', site).href;
  const notesUrl = new URL('/lab-notes/', site).href;
  const thanksUrl = new URL('/thanks/', site).href;

  cpSync(source, output, { recursive: true });
  const read = (path) => readFileSync(join(output, path), 'utf8');
  const write = (path, body) => writeFileSync(join(output, path), body);

  write('.surgeignore', '!/.well-known/\n');
  write('index.html', read('index.html').replaceAll('href="/quote"', 'href="/quote/"'));
  const quote = read('quote/index.html')
    .replace('action="/thanks/" data-netlify="true" netlify-honeypot="bot-field"', 'action="' + inboxForm + '"')
    .replace('<input type="hidden" name="form-name" value="quote">', [
      '<input type="hidden" name="_next" value="' + thanksUrl + '">',
      '<input type="hidden" name="_captcha" value="false">',
      '<input type="hidden" name="_subject" value="New Phantom Pipe quote request">',
    ].join('\n      '))
    .replace('name="bot-field"', 'name="_honey"');
  write('quote/index.html', quote);

  offer.site_url = site.href;
  offer.contact.url = quoteUrl;
  Object.assign(offer.quote_request, {
    url: inboxJson,
    content_type: 'application/json',
    accept: 'application/json',
    response: 'The response acknowledges the submission and does not contain a quote or payment link. We follow up at the reply-to email.',
  });
  delete offer.quote_request.fields['form-name'];
  delete offer.quote_request.json_body;
  write('offer.json', JSON.stringify(offer, null, 2) + '\n');

  const llms = read('llms.txt')
    .replace(/^To submit a request programmatically,.*$/m, [
      'To submit a request programmatically, POST a JSON object to ' + inboxJson + ' with Content-Type: application/json and Accept: application/json.',
      'Send name, email, service, and brief. The company field is optional.',
      'Use a reply-to email that can receive follow-up. The POST does not return a quote and does not take payment.',
    ].join(' '))
    .replaceAll(offer.url + 'offer.json', new URL('/offer.json', site).href)
    .replaceAll(offer.url + 'quote', quoteUrl)
    .replace(offer.url + 'lab-notes/', notesUrl)
    .replace('(' + offer.url + ')', '(' + site.href + ')');
  write('llms.txt', llms);
  write('robots.txt', read('robots.txt').replace(offer.url, site.href));
  write('sitemap.xml', read('sitemap.xml')
    .replace(offer.url + 'quote', quoteUrl)
    .replace(offer.url + 'lab-notes/', notesUrl)
    .replace(offer.url, site.href));
}

if (require.main === module) {
  const output = resolve(__dirname, '../dist/surge');
  buildSurge({
    siteUrl: process.env.SURGE_SITE_URL,
    recipient: process.env.QUOTE_RECIPIENT,
    output,
  });
  console.log('Built dist/surge');
}

module.exports = { buildSurge };
