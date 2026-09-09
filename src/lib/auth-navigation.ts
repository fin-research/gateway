/** Public navigation includes the portal, market reports and authentication bootstrap. */
export function pageRequiresLogin(path: string): boolean {
  try {
    const normalized = decodeURIComponent(path).replace(/\/__data\.json$/, '').replace(/\/$/, '') || '/';
    return !['/', '/market-briefing', '/market-briefing/text', '/auth/verify-email', '/auth/logout', '/auth/session'].includes(normalized)
      && !normalized.startsWith('/_app/');
  } catch { return true; }
}
export function apiRequiresLogin(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\r\n]/.test(decoded)) return '/';
    const normalized = new URL(decoded, 'https://eastmoney.hasbai.xyz');
    if (/^\/(auth|cdn-cgi)(\/|$)/.test(normalized.pathname)) return '/';
  } catch { return '/'; }
  const target = new URL(value, 'https://eastmoney.hasbai.xyz');
  if (target.origin !== 'https://eastmoney.hasbai.xyz') return '/';
  return target.pathname + target.search + target.hash;
}

export function loginUrl(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}
