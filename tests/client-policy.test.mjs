import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_PERMISSIONS, clientRequestPermission, matchDashboardRoute } from '../src/lib/route-permissions.ts';
import { requestPolicy } from '../src/lib/server/permission-policy.ts';

test('generated client preflights agree with server methods, dynamic paths, aliases and named actions', () => {
  for (const [route, methods] of Object.entries(ROUTE_PERMISSIONS)) {
    const path = route.replace('[[view]]', 'assistant').replace('[...path]', 'table').replace(/\[[^\]]+\]/g, 'unit');
    for (const key of Object.keys(methods)) {
      const [method, action] = key.split(':');
      const url = new URL(path + (action ? '?/' + action : ''), 'https://eastmoney.hasbai.xyz');
      const id = matchDashboardRoute(path);
      const server = requestPolicy(new Request(url, { method }), id);
      assert.equal(clientRequestPermission(url, method), server.public ? 'public' : server.login ? 'login' : server.permission, `${route} ${key}`);
    }
  }
  for (const path of ['/api/credit?bad=1', '/trading-research/credit-assistant', '/financing/data/api/rpc/liability_weekly_report_data']) {
    const url = new URL(path, 'https://eastmoney.hasbai.xyz');
    const method = path.includes('/rpc/') ? 'POST' : 'GET';
    const server = requestPolicy(new Request(url, { method }), matchDashboardRoute(url.pathname));
    assert.equal(clientRequestPermission(url, method), server.permission);
  }
  for (const path of ['/financing/projects?/createProject&/deleteProject', '/financing/projects?/deleteProject&/deleteProject', '/api/%2fcredit', '/api/credit?/%20']) {
    assert.equal(clientRequestPermission(new URL(path, 'https://eastmoney.hasbai.xyz'), 'POST'), undefined);
  }
});
