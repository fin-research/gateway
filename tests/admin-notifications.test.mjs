import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPolicy} from '../src/lib/server/permission-policy.ts';
import {authorizeRequest} from '../src/lib/server/authorization.ts';
import {fixture} from './helpers/fixture.mjs';
test('personal notification routes require login, management operations require admin',()=>{
 for(const path of ['/management','/management/me','/management/permissions','/management/notifications'])assert.deepEqual(requestPolicy(new Request('https://eastmoney.hasbai.xyz'+path),path),{login:true});
 for(const path of ['/management/people','/management/messenger'])assert.deepEqual(requestPolicy(new Request('https://eastmoney.hasbai.xyz'+path),path),{admin:true});
 for(const path of ['/service-worker.js','/manifest.webmanifest','/pwa-192.png','/pwa-512.png','/offline.html','/offline'])assert.deepEqual(requestPolicy(new Request('https://eastmoney.hasbai.xyz'+path),null),{public:true});
});
test('legacy broad scopes cannot access admin backend',async t=>{
 const f=await fixture(t);await f.updateGrants(['auth.permission:read','messenger.delivery:read']);
 const token=await f.signed();
 await assert.rejects(authorizeRequest(f.request('/management/people',{token}),f.env,'/management/people'),{status:403});
 await authorizeRequest(f.request('/management/notifications',{token}),f.env,'/management/notifications');
});

test('signed admin role grants full site permissions and backend access',async t=>{
 const f=await fixture(t);await f.updateGrants([]);
 const token=await f.signed({user:{...f.userClaims,roles:[{id:'rol_TestAdmin',name:'admin'}]}});
 const result=await authorizeRequest(f.request('/management/people',{token}),f.env,'/management/people');
 assert.ok(result.permissions.includes('financing.project:delete'));
 const forged=await f.signed({user:{...f.userClaims,roles:[{id:'rol_Unregistered',name:'admin'}]}});
 await assert.rejects(authorizeRequest(f.request('/management/people',{token:forged}),f.env,'/management/people'),{status:403});
});
