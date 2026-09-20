import assert from 'node:assert/strict';
import test from 'node:test';
import { portalServerSettings } from '../scripts/lib/mcp-portal-servers.mjs';
test('portal PUT preserves overrides without copying response-only metadata',()=>{
  const value=portalServerSettings({server_id:'data',name:'Data',status:'ready',last_synced:'now',tools:[{name:'health'}],on_behalf:true,updated_tools:[{name:'health',enabled:false,portal_alias:'status',portal_description:'Current status',server_alias:'ignored'}]});
  assert.deepEqual(value,{server_id:'data',on_behalf:true,default_disabled:false,updated_tools:[{name:'health',enabled:false,alias:'status',description:'Current status'}]});
  assert.deepEqual(portalServerSettings(value),value);
});
