import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { SessionCookies, createHttpSession, loginTestAccount, parseLoginPage } from '../scripts/lib/programmatic-login.mjs';
const site='https://eastmoney.hasbai.xyz', auth='https://auth.hasbai.xyz';
const redirect=(location,cookies=[])=>new Response(null,{status:302,headers:[['Location',location],...cookies.map(c=>['Set-Cookie',c])]});
async function oauthFixture(options={}) {
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),alg:'RS256',kid:crypto.randomUUID()};
  let params,passwords=0,exchanges=0,api=0;
  const sign=(aud,claims)=>new SignJWT({org_id:'org_6yvoRRCkzk3eGkBS',email:'test@18.cn',azp:'16vMxoYpr5AdPRiW1PkwIiHuRWszii6m',role:'authenticated',_roles:['authenticated'],...claims})
    .setSubject('auth0|test').setIssuer(auth+'/').setAudience(aud).setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(privateKey);
  const fetcher=async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:input);
    if(url.pathname==='/authorize') {
      params=url.searchParams;
      assert.equal(params.get('organization'),'org_6yvoRRCkzk3eGkBS');
      assert.equal(params.get('code_challenge_method'),'S256');
      assert.equal(params.get('response_type'),'code');
      return redirect('/u/login/identifier?state=form',['auth0=unit-provider; Path=/; Secure; HttpOnly']);
    }
    if(url.pathname==='/u/login/identifier') {
      if(init.method==='POST') {
        const body=new URLSearchParams(init.body);
        assert.equal(body.get('username'),'test@18.cn');assert.equal(body.get('state'),'one&two');
        assert.equal(body.has('password'),false);return redirect('/u/login/password?state=form');
      }
      return new Response('<form method="POST"><input name="state" value="one&amp;two"><input name="username"><button name="action" value="default">Next</button></form>');
    }
    if(url.pathname==='/u/login/password') {
      if(init.method==='POST') {
        passwords++;
        assert.equal(new URLSearchParams(init.body).get('password'),'unit-password');
        if(options.repeatPassword)return new Response('<form method="POST"><input name="password"></form>');
        const state=options.state==='mismatch'?'wrong':params.get('state');
        return redirect(site+'/auth/callback?code=unit&state='+state+(options.state==='duplicate'?'&state=extra':''));
      }
      return new Response('<form method="POST"><input name="state" value="password"><input name="username"><input name="password"></form>');
    }
    if(url.pathname==='/oauth/token') {
      exchanges++;
      const body=new URLSearchParams(init.body);
      assert.equal(body.has('client_secret'),false);
      assert.equal(body.get('client_id'),params.get('client_id'));
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),params.get('code_challenge'));
      if(options.exchangeRedirect)return redirect('https://evil.test/collect');
      return Response.json({token_type:'Bearer',access_token:await sign(site+'/',options.claims),id_token:await sign(params.get('client_id'),{nonce:options.nonceWrong?'wrong':params.get('nonce')})});
    }
    if(url.pathname==='/.well-known/jwks.json')return Response.json({keys:[jwk]});
    if(url.pathname==='/api/profile') {
      api++;
      assert.match(init.headers.get('Authorization'),/^Bearer /);
      assert.equal(init.headers.get('Cookie'),null);
      return Response.json({email:'test@18.cn',emailVerified:true,permissions:[]});
    }
    throw new Error('unexpected HTTP endpoint');
  };
  return {fetcher,counts:()=>({passwords,exchanges,api})};
}

test('programmatic public PKCE verifies signed current claims and sends only Bearer to the site',async()=>{
  const f=await oauthFixture();const session=await loginTestAccount({email:'test@18.cn',password:'unit-password'},f.fetcher);
  assert.equal(session.profile.email,'test@18.cn');assert.deepEqual(session.claims._roles,['authenticated']);
  assert.deepEqual(f.counts(),{passwords:1,exchanges:1,api:1});
});

test('cookie domain and path scoping keep Auth0 transaction cookies on the correct origin',()=>{
  const jar=new SessionCookies();jar.update(new Headers({'Set-Cookie':'auth0=unit; Path=/u; Secure'}),auth+'/u/login');
  assert.equal(jar.header(site),'');assert.equal(jar.header(auth+'/user'),'');assert.equal(jar.header(auth+'/u/login'),'auth0=unit');
  jar.update(new Headers({'Set-Cookie':'bad=unit; Domain=evil.test; Path=/'}),auth);assert.equal(jar.header('https://evil.test/'),'');
});

test('unsafe redirects and interactive profile steps fail without browser fallback or mutation',async()=>{
  const session=createHttpSession(async()=>redirect('https://evil.test/collect'));
  await assert.rejects(session.request(site),{code:'UNTRUSTED_ORIGIN'});
  const replay=createHttpSession(async()=>new Response(null,{status:307,headers:{Location:'/u/login/password'}}));
  await assert.rejects(replay.request(auth+'/u/login/password',{method:'POST',body:'password=unit'}),{code:'POST_REDIRECT'});
  assert.equal(parseLoginPage('<form method="POST"><input name="state" value="&#65;&amp;B"></form>').forms[0].controls[0].value,'A&B');
  let calls=0;
  await assert.rejects(loginTestAccount({email:'test@18.cn',password:'unit-password'},async()=>++calls===1?redirect(auth+'/u/custom-prompt/profile'):new Response('Profile')),{code:'PROFILE_REQUIRED'});
});

test('mismatched and duplicate callback state never exchange an authorization code',async()=>{
  for(const state of ['mismatch','duplicate']) {
    const f=await oauthFixture({state});await assert.rejects(loginTestAccount({email:'test@18.cn',password:'unit-password'},f.fetcher),{code:'CALLBACK_INVALID'});
    assert.equal(f.counts().exchanges,0);
  }
});

test('ID token nonce and obsolete access-token claims cannot establish a Bearer login',async()=>{
  for(const options of [{nonceWrong:true},{claims:{role:undefined,_roles:undefined,user:{email:'test@18.cn',roles:[]}}}]) {
    const f=await oauthFixture(options);await assert.rejects(loginTestAccount({email:'test@18.cn',password:'unit-password'},f.fetcher));
    assert.equal(f.counts().api,0);
  }
});

test('failed password form is never submitted a second time',async()=>{
  const f=await oauthFixture({repeatPassword:true});
  await assert.rejects(loginTestAccount({email:'test@18.cn',password:'unit-password'},f.fetcher),{code:'LOGIN_REJECTED'});
  assert.equal(f.counts().passwords,1);assert.equal(f.counts().exchanges,0);
});

test('token exchange cannot redirect public-client PKCE credentials',async()=>{
  const f=await oauthFixture({exchangeRedirect:true});
  await assert.rejects(loginTestAccount({email:'test@18.cn',password:'unit-password'},f.fetcher),{code:'TOKEN_EXCHANGE_FAILED'});
  assert.equal(f.counts().api,0);
});
