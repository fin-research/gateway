import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mcpIdentityClaim} from '../src/mcp-auth.ts';
const code=readFileSync(new URL('../auth0/actions/login-claims.cjs',import.meta.url),'utf8');
async function run(clientId,changes={}){
  const event={client:{client_id:clientId},organization:{id:'org_6yvoRRCkzk3eGkBS'},connection:{name:'eastmoney-email'},
    user:{email:'test@18.cn',email_verified:true,name:'测试',user_metadata:{department:'研究'}},authorization:{roles:['authenticated']},...changes};
  const context={exports:{}};vm.runInNewContext(code,context);
  const claims={},denials=[];await context.exports.onExecutePostLogin(event,{accessToken:{setCustomClaim:(name,value)=>{claims[name]=value;}},access:{deny:message=>denials.push(message)}});
  return {claims,denials};
}
test('CIMD Action issues identity only from verified organization accounts, including refresh logins',async()=>{
  for(const id of ['tpc_a7WD9gnnwfLwzjTcG3aN8m','tpc_2WkMuCZoYq49waTvQZjJHK','tpc_mJaDePAHohZSgFrpLBfWny']){
    for(const protocol of ['oidc-basic-profile','oauth2-refresh-token']){
      const result=await run(id,{transaction:{protocol}});assert.equal(result.denials.length,0);
      assert.deepEqual(JSON.parse(JSON.stringify(result.claims[mcpIdentityClaim])),{username:'测试',email:'test@18.cn',role:'authenticated',_roles:['authenticated'],department:'研究',picture:''});
    }
    for(const changes of [{organization:{id:'org_Other'}},{connection:{name:'google-oauth2'}},{user:{email:'test@example.com',email_verified:true}},{user:{email:'test@18.cn',email_verified:false}},{user:{email:'test@18.cn',email_verified:true,blocked:true}}]){
      const result=await run(id,changes);assert.equal(result.denials.length,1);assert.equal(result.claims[mcpIdentityClaim],undefined);
    }
  }
  const website=await run('16vMxoYpr5AdPRiW1PkwIiHuRWszii6m');assert.equal(website.claims.email,'test@18.cn');assert.equal(website.claims[mcpIdentityClaim],undefined);
});
