import { management } from './lib/auth0-management.mjs';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const org='org_6yvoRRCkzk3eGkBS', email='shiyue@18.cn', audience='https://eastmoney.hasbai.xyz/';
const mode=process.argv[2] ?? 'plan';
if(!['plan','apply','verify'].includes(mode))throw new Error('Expected plan/apply/verify');
function list(path){const all=[];for(let page=0;page<100;page++){const rows=management('get',`${path}?per_page=100&page=${page}`);if(!Array.isArray(rows))throw new Error('Invalid pagination');all.push(...rows);if(rows.length<100)return all;}throw new Error('Pagination limit');}
const members=list(`organizations/${org}/members`);
const matches=members.filter(m=>m.email?.toLowerCase()===email);
if(matches.length!==1)throw new Error('Expected exactly one administrator organization member');
const owner=management('get',`users/${encodeURIComponent(matches[0].user_id)}`);
if(owner.blocked || !owner.identities?.some(i=>i.connection==='eastmoney-email'))throw new Error('Administrator identity unavailable');
let role=list('roles').find(r=>r.name==='admin'&&r.owner_id===org);
const memberships=[];
for(const member of members)memberships.push({id:member.user_id,roles:list(`organizations/${org}/members/${encodeURIComponent(member.user_id)}/roles`)});
const plan={org,owner:owner.user_id,role:role?.id ?? null,remove:memberships.filter(m=>m.id!==owner.user_id&&m.roles.some(r=>r.id===role?.id)).map(m=>m.id)};
if(mode==='plan'){
 await mkdir('.auth0-deploy/site-admin',{recursive:true,mode:0o700});
 await writeFile('.auth0-deploy/site-admin/plan.json',JSON.stringify(plan),{mode:0o600});
 console.log(JSON.stringify({mode,createRole:!role,soleAdministrator:email,removeCount:plan.remove.length}));
}else{
 const previous=JSON.parse(await readFile('.auth0-deploy/site-admin/plan.json','utf8'));
 if(previous.owner!==plan.owner||previous.org!==org||JSON.stringify(previous.remove)!==JSON.stringify(plan.remove))throw new Error('Plan changed');
 if(mode==='apply'){
  role ??= management('post','roles',{name:'admin',description:'全站管理员',type:'organization',owner_id:org});
  const granted=list(`roles/${role.id}/permissions`);
  const missing=PERMISSION_CODES.filter(code=>!granted.some(p=>p.permission_name===code&&p.resource_server_identifier===audience));
  if(missing.length)management('post',`roles/${role.id}/permissions`,{permissions:missing.map(permission_name=>({permission_name,resource_server_identifier:audience}))});
  for(const id of plan.remove)management('delete',`organizations/${org}/members/${encodeURIComponent(id)}/roles`,{roles:[role.id]});
  management('post',`organizations/${org}/members/${encodeURIComponent(owner.user_id)}/roles`,{roles:[role.id]});
 }
 if(!role)throw new Error('Admin missing');
 const actual=members.filter(m=>list(`organizations/${org}/members/${encodeURIComponent(m.user_id)}/roles`).some(r=>r.id===role.id));
 if(actual.length!==1||actual[0].user_id!==owner.user_id)throw new Error('Admin membership verification failed');
 console.log(JSON.stringify({mode,roleId:role.id,soleAdministrator:email,verified:true}));
}
