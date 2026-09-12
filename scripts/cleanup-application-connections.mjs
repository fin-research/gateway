// Deploy CLI exports the baseline, but its enabled_clients update replaces the
// entire list. Use Auth0's granular association API to preserve concurrently
// added Hasbai clients and every connection's shared options.
import { management as m } from './lib/auth0-management.mjs';
const apply = process.argv.includes('--apply');
const web = '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m';
const portal = 'M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV';
const owned = new Set([web, portal, 'LA46CcB3FQ4Uac4JyEzPSObcV4PV8CFU', 'MriIYaKO6xE8QfOAMdiQMxmKeSq53eHo',
  'rpBS8lgdzn7LXhImz8BGiKLPSTjztcwz', '9t8TBoWunhy0MXjI8rvXm6wgVb45nwnS', 'Ja1Jra2z1ifOKOUnA9M2qu3JzUudgW4j']);
const connections = [['con_YKnh8Ydf31QO4pol', 'eastmoney-email'], ['con_kGVFIfe24V8o1nWu', 'google-oauth2'], ['con_jEHW8XUFpxA5SyYU', 'Username-Password-Authentication']];
function clients(id) {
  let from; const result = [];
  do {
    const page = m('get', `connections/${id}/clients?take=100${from ? '&from=' + encodeURIComponent(from) : ''}`);
    if (!Array.isArray(page.clients)) throw new Error('Unexpected client associations');
    result.push(...page.clients.map(c => c.client_id)); from = page.next;
  } while (from);
  return result;
}
for (const [id, name] of connections) {
  if (m('get', `connections/${id}`).name !== name) throw new Error('Unexpected connection ownership');
  const before = clients(id);
  const removed = before.filter(client => name === 'eastmoney-email' ? ![web, portal].includes(client) : owned.has(client));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', connection: name, removedAssociations: removed.length, retainedClients: before.filter(c => !removed.includes(c)).length }));
  if (apply && removed.length) {
    m('patch', `connections/${id}/clients`, removed.map(client_id => ({ client_id, status: false })));
    const after = new Set(clients(id));
    if (removed.some(c => after.has(c)) || before.filter(c => !removed.includes(c)).some(c => !after.has(c))) throw new Error('Association cleanup readback mismatch');
  }
}
