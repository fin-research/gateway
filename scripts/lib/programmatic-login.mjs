import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export const SITE_ORIGIN = 'https://eastmoney.hasbai.xyz';
const LOGIN_ORIGIN = 'https://auth.hasbai.xyz';
const TRUSTED_ORIGINS = new Set([SITE_ORIGIN, LOGIN_ORIGIN]);
const MAX_BODY = 2 * 1024 * 1024;

export class AuthTestError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthTestError'; this.code = code; }
}
const fail = (code, message) => { throw new AuthTestError(code, message); };
function checkedUrl(value, base) {
  const url = new URL(value, base);
  if (!TRUSTED_ORIGINS.has(url.origin) || url.username || url.password) fail('UNTRUSTED_ORIGIN', 'Login attempted an unapproved origin');
  return url;
}
export async function readAuthTestConfig(path = process.env.AUTH_TEST_ENV_FILE) {
  const file = path ?? new URL('../../../eastmoney/.env', import.meta.url);
  let config;
  try { config = parseEnv(await readFile(file, 'utf8')); }
  catch { fail('CREDENTIALS_MISSING', 'Cannot read the project-root .env; set AUTH_TEST_ENV_FILE for a worktree'); }
  if (config.AUTH_TEST_EMAIL !== 'test@18.cn' || !config.AUTH_TEST_PASSWORD) {
    fail('CREDENTIALS_MISSING', 'Root .env must configure AUTH_TEST_EMAIL=test@18.cn and AUTH_TEST_PASSWORD');
  }
  return { email: config.AUTH_TEST_EMAIL, password: config.AUTH_TEST_PASSWORD };
}

// This is an HTTP cookie jar, not a browser. It never executes page JavaScript.
export class SessionCookies {
  #cookies = new Map();
  update(headers, source) {
    const url = new URL(source);
    for (const raw of headers.getSetCookie()) {
      const [pair, ...parts] = raw.split(';'); const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim(); const value = pair.slice(at + 1);
      const attrs = new Map(parts.map(part => { const i = part.indexOf('='); return i < 0
        ? [part.trim().toLowerCase(), ''] : [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]; }));
      const domain = (attrs.get('domain') ?? url.hostname).replace(/^\./, '').toLowerCase();
      if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) continue;
      const path = attrs.get('path')?.startsWith('/') ? attrs.get('path') : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
      const key = [domain, path, name].join('\n');
      const expires = attrs.has('max-age') ? Date.now() + Number(attrs.get('max-age')) * 1000
        : attrs.has('expires') ? Date.parse(attrs.get('expires')) : Infinity;
      if (!value || expires <= Date.now()) this.#cookies.delete(key);
      else this.#cookies.set(key, { name, value, domain, path, expires, hostOnly: !attrs.has('domain'), secure: attrs.has('secure') });
    }
  }
  header(target) {
    const url = new URL(target);
    return [...this.#cookies.values()].filter(c => c.expires > Date.now()
      && (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith('.' + c.domain))
      && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/'))
      && (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
  hasSiteSession() { return /(?:^|; )__Host-eastmoney_session=/.test(this.header(SITE_ORIGIN + '/')); }
}

function decode(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const n = entity.slice(2, -1); const code = n[0]?.toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function attributes(tag) {
  const result = {};
  for (const [, name, double, single, bare] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[name.toLowerCase()] = decode(double ?? single ?? bare);
  return result;
}
export function parseLoginPage(html) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, tag, body]) => ({
    ...attributes(tag), controls: [...body.matchAll(/<(?:input|button)\b([^>]*)>/gi)].map(([, attrs]) => attributes(attrs)),
  }));
  const links = [...html.matchAll(/<a\b([^>]*)>/gi)].map(([, tag]) => attributes(tag).href).filter(Boolean);
  return { forms, links };
}
async function boundedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); fail('RESPONSE_TOO_LARGE', 'Authentication response exceeds the read limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpSession(fetcher = fetch) {
  const cookies = new SessionCookies();
  async function request(target, options = {}) {
    let url = checkedUrl(target); let method = options.method ?? 'GET'; let body = options.body;
    for (let hop = 0; hop < 16; hop++) {
      const headers = new Headers({ Accept: 'text/html', 'User-Agent': 'Eastmoney-Authorization-Test/1.0', ...options.headers });
      const cookie = cookies.header(url); if (cookie) headers.set('Cookie', cookie);
      if (body !== undefined) {
        if (url.origin !== LOGIN_ORIGIN || method !== 'POST') fail('CREDENTIAL_DESTINATION', 'Login form submissions are restricted to the Auth0 login origin');
        headers.set('Content-Type', 'application/x-www-form-urlencoded'); headers.set('Origin', LOGIN_ORIGIN);
      }
      let response;
      try { response = await fetcher(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
      catch { fail('HTTP_FAILURE', `HTTP request failed at ${url.hostname}${url.pathname}`); }
      cookies.update(response.headers, url);
      const location = response.headers.get('location');
      if (options.followRedirects !== false && response.status >= 300 && response.status < 400 && location) {
        const next = checkedUrl(location, url);
        if (body !== undefined && [307, 308].includes(response.status)) { await response.body?.cancel(); fail('POST_REDIRECT', 'Refusing to replay credentials across a redirect'); }
        await response.body?.cancel(); url = next; method = 'GET'; body = undefined; continue;
      }
      return { url, status: response.status, headers: response.headers, text: await boundedText(response) };
    }
    fail('REDIRECT_LIMIT', 'Login redirect limit exceeded');
  }
  return { cookies, request };
}

export async function loginTestAccount(config, fetcher = fetch) {
  if (config.email !== 'test@18.cn' || !config.password) fail('TEST_ACCOUNT_REQUIRED', 'Only the configured test account can run this verification');
  const session = createHttpSession(fetcher);
  let response = await session.request(SITE_ORIGIN + '/auth/login?returnTo=%2Fprofile');
  let identifierSent = false; let passwordSent = false;
  for (let step = 0; step < 6; step++) {
    if (response.url.origin === SITE_ORIGIN && session.cookies.hasSiteSession()) {
      const identity = await session.request(SITE_ORIGIN + '/api/profile', { headers: { Accept: 'application/json' }, followRedirects: false });
      let profile; try { profile = JSON.parse(identity.text); } catch { /* handled below */ }
      if (identity.status !== 200 || profile?.email !== config.email || profile?.emailVerified !== true) fail('IDENTITY_NOT_CONFIRMED', 'Login completed without a confirmed test-account profile');
      return { ...session, profile };
    }
    if (response.status !== 200) fail('LOGIN_REJECTED', `Login was rejected at ${response.url.hostname}${response.url.pathname} (HTTP ${response.status})`);
    if (response.url.pathname.startsWith('/u/custom-prompt/')) fail('PROFILE_REQUIRED', 'The test account must complete its required Auth0 name/department form before Gateway can issue a session');
    if (response.url.pathname === '/auth/verify-email') fail('EMAIL_VERIFICATION_REQUIRED', 'The test account must verify its email before a fresh programmatic login');
    const page = parseLoginPage(response.text);
    if (response.url.origin !== LOGIN_ORIGIN || !['/u/login/identifier', '/u/login/password', '/u/login'].includes(response.url.pathname)) {
      fail('UNSUPPORTED_LOGIN_STEP', 'Login requires an unsupported interactive step; browser fallback is prohibited');
    }
    const form = page.forms.find(form => form.controls.some(control => ['username', 'password'].includes(control.name)));
    if (!form || form.method?.toUpperCase() !== 'POST') fail('LOGIN_FORM_MISSING', 'Expected an Auth0 credential form');
    const target = checkedUrl(form.action ?? '', response.url);
    if (target.origin !== LOGIN_ORIGIN) fail('CREDENTIAL_DESTINATION', 'Credentials may only be submitted to Auth0');
    const values = new URLSearchParams(form.controls.filter(c => c.name && !['checkbox', 'radio'].includes(c.type)).map(c => [c.name, c.value ?? '']));
    if (values.has('password')) {
      if (passwordSent) fail('LOGIN_REJECTED', 'Password login did not advance; retries are disabled');
      values.set('password', config.password); passwordSent = true;
    } else {
      if (identifierSent) fail('LOGIN_REJECTED', 'Identifier login did not advance; retries are disabled');
      identifierSent = true;
    }
    values.set('username', config.email);
    response = await session.request(target, { method: 'POST', body: values.toString() });
  }
  fail('LOGIN_STEP_LIMIT', 'Login step limit exceeded');
}
