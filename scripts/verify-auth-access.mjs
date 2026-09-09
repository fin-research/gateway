import { setTimeout as pause } from 'node:timers/promises';
import { AuthTestError, SITE_ORIGIN, createHttpSession, loginTestAccount, readAuthTestConfig } from './lib/programmatic-login.mjs';

// GET only. Missing-record probes verify the authorization/validation boundary
// without querying paid Choice data, generating AI, or mutating business state.
export const ACCESS_PROBES = [
  ['public', '/market-briefing', [200]],
  ['public', '/market-briefing/text', [200]],
  ['public', '/api/market-report', [400]],
  ['public', '/api/market-resources/unknown', [400]],
  ['public', '/data/omo', [422]],
  ['public', '/data/news?pageSize=invalid', [422]],
  ['public', '/data/margin?date=invalid', [422]],
  ['research.hotspot:read', '/trading-research/market-hotspots', [200]],
  ['research.policy:read', '/trading-research/policy-tracking', [200]],
  ['research.article:read', '/news/auth-test-missing-record', [200]],
  ['research.workspace:read', '/trading-research', [200]],
  ['research.economic_indicator:read', '/api/economic-indicators', [200]],
  ['bond.ledger:read', '/secondary-bond-pool', [200]],
  ['credit.institution:read', '/credit-workbench', [200]],
  ['credit.assistant:read', '/credit-workbench/assistant', [200]],
  ['fund.report:read', '/fund-report', [200]],
  ['model.financing:read', '/financing-model', [200]],
  ['financing.overview:read', '/financing', [200]],
  ['financing.project:read', '/financing/projects', [200]],
  ['financing.sop:read', '/financing/sop', [200]],
  ['financing.reminder:read', '/financing/sop/reminders', [200]],
  ['financing.data:read', '/financing/data', [200]],
  ['financing.report:read', '/financing/liability-report', [200]],
  ['account.profile:read', '/api/profile', [200]],
  ['auth.permission:read', '/management/people', [200]],
  ['public', '/data/health', [200]],
  ['public', '/data/graphql', [200]],
  ['login', '/data/choice/css', [422]],
  ['login', '/data/choice/csd', [422]],
  ['login', '/data/choice/ctr', [422]],
  ['login', '/data/choice/edb', [422]],
  ['login', '/data/camel', [404]],
];

function denied(response) {
  if ([401, 403].includes(response.status)) return true;
  if (![302, 303].includes(response.status)) return false;
  const location = response.headers.get('location');
  if (!location) return false;
  const target = new URL(location, SITE_ORIGIN);
  return (target.origin === SITE_ORIGIN && target.pathname === '/auth/login')
;
}

async function main() {
  const config = await readAuthTestConfig();
  const anonymous = createHttpSession();
  const failures = [];
  for (const [scope, path, expected] of ACCESS_PROBES) {
    const response = await anonymous.request(SITE_ORIGIN + path, { headers: { Accept: path.startsWith('/api/') || path.startsWith('/data/') ? 'application/json' : 'text/html' }, followRedirects: false });
    const passed = scope === 'public' ? expected.includes(response.status) : denied(response);
    console.log(JSON.stringify({ identity: 'anonymous', scope, path: new URL(path, SITE_ORIGIN).pathname, status: response.status, passed }));
    if (!passed) failures.push(`anonymous ${scope}`);
  }
  const session = await loginTestAccount(config);
  const permissions = new Set((session.profile.permissions ?? []).map(item => item.name));
  for (const [scope, path, expected] of ACCESS_PROBES) {
    await pause(1500);
    const response = await session.request(SITE_ORIGIN + path, { headers: { Accept: path.startsWith('/api/') || path.startsWith('/data/') ? 'application/json' : 'text/html' }, followRedirects: false });
    const permitted = ['public', 'login'].includes(scope) || permissions.has(scope);
    const passed = permitted ? expected.includes(response.status) : response.status === 403;
    let failureDetail;
    if (!passed && response.headers.get('content-type')?.includes('json')) {
      try { const error = JSON.parse(response.text); failureDetail = String(error.detail ?? error.message ?? '').slice(0,180); } catch { /* no raw body in logs */ }
    }
    console.log(JSON.stringify({ identity: config.email, scope, path: new URL(path, SITE_ORIGIN).pathname,
      granted: permitted, status: response.status, passed, ...(failureDetail ? { detail: failureDetail } : {}) }));
    if (!passed) failures.push(`test-account ${scope}`);
  }
  console.log(JSON.stringify({ programmaticLogin: true, browserUsed: false, probes: ACCESS_PROBES.length * 2,
    testAccount: config.email, permissions: permissions.size, failures }));
  if (failures.length) process.exitCode = 1;
}
main().catch(error => {
  console.error(JSON.stringify({ programmaticLogin: false, browserUsed: false,
    code: error instanceof AuthTestError ? error.code : 'VERIFICATION_FAILED',
    message: error instanceof AuthTestError ? error.message : 'Access verification failed; inspect the sanitized probe results' }));
  process.exitCode = 1;
});
