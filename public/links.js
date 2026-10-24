export function normalizeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.href.length > 320) {
    throw new Error('Use a valid HTTPS link.');
  }
  return url.href;
}
