/** Runtime config accepts either an explorer website root or its /api base. */
export function blockscoutApiUrl(configured, explorer, dashboard) {
  const value = configured || explorer;
  if (!value) return '';
  const url = new URL(value, explorer || dashboard);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v2$/, '/api');
  if (!path.endsWith('/api')) path += '/api';
  url.pathname = path;
  return url.href.replace(/\/$/, '');
}
