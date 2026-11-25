export const untaggedVariant = '_untagged';

export function isVariant(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value);
}

export function variantOf(url) {
  const variant = url.searchParams.get('v');
  return isVariant(variant) ? variant : untaggedVariant;
}

export function withVariant(path, source) {
  if (!source.searchParams.has('v')) return path;
  return path + (path.includes('?') ? '&' : '?') + 'v=' + variantOf(source);
}
