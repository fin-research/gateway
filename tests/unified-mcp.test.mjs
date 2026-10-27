import assert from 'node:assert/strict';
import test from 'node:test';
import {gatewayRequest} from '../src/app.ts';
import {fixture} from './helpers/fixture.mjs';
import {mcpClientIds,mcpIdentityClaim} from '../src/mcp-auth.ts';

const tool=name=>({name,description:name,inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}});
function applications(f){
  let failData=false,duplicate=false,writeError=false;
  for(const owner of ['dashboard','data']) f.env[owner==='dashboard'?'DASHBOARD':'DATA']={async fetch(request){
    f.calls[owner].push(request);assert.equal(request.headers.has('Authorization'),false);assert.equal(request.headers.has('Cookie'),false);
    assert.equal(request.headers.get('X-User-Id'),null);
    const context=JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'),'base64url'));
    assert.equal(context.user.email,'test@18.cn');assert.equal(context.choice.status,204);assert.equal(context.camel,undefined);
    assert.equal(new URL(request.url).pathname,owner==='dashboard'?'/api/mcp':'/data/mcp');
    assert.equal(request.headers.get('MCP-Protocol-Version'),'2025-11-25');
    const message=await request.json();
    if(owner==='data'&&failData)return new Response('sensitive upstream failure',{status:503});
    let result;
    if(message.method==='tools/list'){
      const names=owner==='dashboard'?['news',...(context.user.authorization.permissions.includes('credit.institution:read')?['credit_report']:[]),...(context.user.authorization.permissions.includes('bond.ledger:read')?['bond_ledger']:[]),'create_commentary','generate_market_focus']:['omo','news_list','choice_css','health','camel_borrowings'];
      if(duplicate&&owner==='data')names.push('omo');
      result={tools:names.map(tool)};
    } else result=writeError&&message.params.name==='create_commentary'?{isError:true,content:[{type:'text',text:'版本冲突'}]}:{content:[{type:'text',text:message.params.name}],structuredContent:{data:{owner,name:message.params.name}}};
    const value={jsonrpc:'2.0',id:message.id,result};
    return owner==='data'?Response.json(value):new Response(': heartbeat\r\nevent: message\r\ndata: '+JSON.stringify(value)+'\r\n\r\n',{headers:{'Content-Type':'text/event-stream'}});
  }};
  return {failData(){failData=true},duplicate(){duplicate=true},writeError(){writeError=true}};
}
async function rpc(f,method,params={},options={}){
  const token=options.token??await f.signed({azp:mcpClientIds[1],[mcpIdentityClaim]:f.flatClaims,email:undefined});
  const response=await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/mcp',{method:'POST',headers:{Host:new URL(f.env.SITE_ORIGIN).host,Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',Cookie:'private=secret','X-User-Id':'forged',...(method==='server/discover'?{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method}:{}),...options.headers},body:JSON.stringify({jsonrpc:'2.0',id:17,method,params})}),f.env);
  const raw=await response.text();
  const value=response.headers.get('Content-Type')?.includes('text/event-stream')?raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(value=>value.id===17):JSON.parse(raw);
  return {response,value};
}
test('Gateway owns modern/legacy MCP handshake without invoking applications',async t=>{
  const f=await fixture(t);applications(f);
  const init=await rpc(f,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(init.response.status,200);assert.equal(init.value.result.serverInfo.name,'eastmoney');
  const discover=await rpc(f,'server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}});
  assert.equal(discover.response.status,200);assert.ok(discover.value.result.supportedVersions.includes('2026-07-28'));
  assert.equal(f.calls.dashboard.length+f.calls.data.length,0);
});
test('Gateway merges reviewed definitions, preserves schemas and does not cache another user permissions',async t=>{
  const f=await fixture(t);applications(f);
  const list=await rpc(f,'tools/list');assert.equal(list.value.id,17);
  assert.deepEqual(list.value.result.tools.map(t=>t.name),['news','credit_report','bond_ledger','create_commentary','omo','news_list','choice_css']);
  assert.deepEqual(list.value.result.tools[0].inputSchema,tool('news').inputSchema);
  assert.equal(list.response.headers.get('Cache-Control'),'no-store, private');
  await f.updateGrants([]);
  assert.ok(!(await rpc(f,'tools/list')).value.result.tools.some(t=>['credit_report','bond_ledger'].includes(t.name)));
  assert.equal(f.calls.dashboard.length,2);assert.equal(f.calls.data.length,2);
});
test('single calls only reach their owner, keep structured errors and never retry writes',async t=>{
  const f=await fixture(t);const app=applications(f);
  for(const [name,owner] of [['bond_ledger','dashboard'],['credit_report','dashboard'],['news','dashboard'],['news_list','data'],['omo','data'],['choice_css','data']]){
    const before={dashboard:f.calls.dashboard.length,data:f.calls.data.length};
    const result=await rpc(f,'tools/call',{name,arguments:{}});
    assert.deepEqual(result.value.result.structuredContent,{data:{owner,name}});
    assert.equal(f.calls[owner].length,before[owner]+1);assert.equal(f.calls[owner==='data'?'dashboard':'data'].length,before[owner==='data'?'dashboard':'data']);
  }
  app.writeError();const before=f.calls.dashboard.length;
  const failure=await rpc(f,'tools/call',{name:'create_commentary',arguments:{body:{}}});
  assert.equal(failure.value.result.isError,true);assert.equal(failure.value.result.content[0].text,'版本冲突');assert.equal(f.calls.dashboard.length,before+1);
  app.failData();const unavailable=await rpc(f,'tools/call',{name:'omo',arguments:{}});assert.equal(unavailable.value.result.isError,true);assert.doesNotMatch(JSON.stringify(unavailable),/sensitive upstream/);
});
test('unpublished names never reach bindings; failed or duplicate catalogs are rejected',async t=>{
  const f=await fixture(t);const app=applications(f);
  for(const name of ['health','config','stock_summary','generate_market_focus','dashboard_credit_report','data_news','camel_borrowings','generate_bond_report','download_bond_report','update_bond_ledger'])assert.ok((await rpc(f,'tools/call',{name,arguments:{}})).value.error);
  assert.equal(f.calls.dashboard.length+f.calls.data.length,0);
  assert.ok((await rpc(f,'tools/list',{cursor:'unknown'})).value.error);
  app.duplicate();assert.ok((await rpc(f,'tools/list')).value.error);
  app.failData();assert.ok((await rpc(f,'tools/list')).value.error);
});
test('old public endpoints are retired before Data routing and request bodies are bounded',async t=>{
  const f=await fixture(t);applications(f);
  for(const path of ['/api/mcp','/data/mcp'])for(const method of ['GET','POST','DELETE']){
    const r=await gatewayRequest(new Request(f.env.SITE_ORIGIN+path,{method}),f.env);assert.equal(r.status,410);assert.equal((await r.json()).mcpUrl,f.env.SITE_ORIGIN+'/mcp');
  }
  assert.equal(f.calls.dashboard.length+f.calls.data.length,0);
  const token=await f.signed();
  const tooLarge=await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/mcp',{method:'POST',headers:{Host:new URL(f.env.SITE_ORIGIN).host,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:' '.repeat(1024*1024+1)}),f.env);
  assert.equal(tooLarge.status,413);
  for(const method of ['GET','DELETE']) assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/mcp',{method,headers:{Authorization:'Bearer '+token}}),f.env)).status,405);
});
