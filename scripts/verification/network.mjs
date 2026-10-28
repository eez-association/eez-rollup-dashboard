/** Runtime config accepts either an explorer website root or its /api base. */
export function blockscoutApiUrl(configured, explorer, dashboard) {
  const value = configured || explorer;
  if (!value) return '';
  const url = new URL(value, explorer || dashboard || undefined);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v2$/, '/api');
  if (!path.endsWith('/api')) path += '/api';
  url.pathname = path;
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** Append an API route without placing it inside a configured query string. */
export function verificationEndpoint(base, route) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`;
  url.hash = '';
  return url.href;
}
