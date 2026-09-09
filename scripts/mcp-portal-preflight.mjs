const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Run through the Keychain-backed cloudflare-task-session.py');
const account = '5cecc63c78acf8f5473f8745f4244448';
const zone = 'e0665efd9fd68d06cbb9ab68a13cc7c6';
let failed = false;
for (const [resource, path] of [
  ['portals', `accounts/${account}/access/ai-controls/mcp/portals`],
  ['servers', `accounts/${account}/access/ai-controls/mcp/servers`],
  ['applications', `accounts/${account}/access/apps`],
  ['dns', `zones/${zone}/dns_records?name=mcp.hasbai.xyz`],
]) {
  const response = await fetch('https://api.cloudflare.com/client/v4/' + path, {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  const success = response.ok && result.success === true;
  failed ||= !success;
  console.log(JSON.stringify({ resource, status: response.status, success,
    errors: result.errors?.map(error => ({ code: error.code, message: error.message })),
    items: Array.isArray(result.result) ? result.result.map(item => ({ id: item.id, name: item.name, hostname: item.hostname, domain: item.domain })) : undefined,
  }));
}
process.exitCode = failed ? 1 : 0;
