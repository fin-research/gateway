import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/fixture.mjs';
import {gatewayRequest} from '../src/app.ts';

test('direct CAMEL requests require separate read/import grants and exact methods before Data',async t=>{
 const f=await fixture(t),token=await f.signed();
 const get='/data/camel/borrowings?date=invalid',post='/data/camel/borrowings/import';
 assert.equal((await gatewayRequest(f.request(get),f.env)).status,401);
 await f.updateGrants([]);
 assert.equal((await gatewayRequest(f.request(get,{token}),f.env)).status,403);
 await f.updateGrants(['research.interbank:read']);
 assert.equal((await gatewayRequest(f.request(get,{token}),f.env)).status,200);
 assert.equal((await gatewayRequest(f.request(post,{token,method:'POST',body:'{}'}),f.env)).status,403);
 await f.updateGrants(['research.interbank:import']);
 assert.equal((await gatewayRequest(f.request(get,{token}),f.env)).status,403);
 assert.equal((await gatewayRequest(f.request(post,{token,method:'POST',body:'{}'}),f.env)).status,200);
 const forwarded=f.calls.data.at(-1);
 assert.equal(forwarded.headers.has('Authorization'),false);
 assert.equal(JSON.parse(Buffer.from(forwarded.headers.get('X-Eastmoney-Gateway-Context'),'base64url')).camel.status,204);
 const count=f.calls.data.length;
 for(const headers of [{Origin:'https://other.test'},{Origin:''}]) assert.equal((await gatewayRequest(f.request(post,{token,method:'POST',headers,body:'{}'}),f.env)).status,403);
 for(const path of ['/data/camel','/data/camel/accounts','/data/camel/repayment-drafts/1/submit','/api/interbank/borrowings']) assert.equal((await gatewayRequest(f.request(path,{token}),f.env)).status,403);
 assert.equal((await gatewayRequest(f.request(get,{token,method:'DELETE'}),f.env)).status,403);
 assert.equal(f.calls.data.length,count);
 assert.equal(f.calls.dashboard.length,0);
});
