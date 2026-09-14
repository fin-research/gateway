export const GATEWAY_MANAGEMENT_CLIENT_ID = 'LA46CcB3FQ4Uac4JyEzPSObcV4PV8CFU';
export const GATEWAY_MANAGEMENT_CLIENT_NAME = 'eastmoney gateway management';
export const GATEWAY_MANAGEMENT_SCOPES = [
  'read:users', 'update:users', 'read:roles', 'read:organization_members',
  'read:organization_member_roles', 'create:organization_member_roles',
];
export function assertGatewayManagementClient(client, grants) {
  if (client.client_id !== GATEWAY_MANAGEMENT_CLIENT_ID || client.name !== GATEWAY_MANAGEMENT_CLIENT_NAME
    || client.app_type !== 'non_interactive' || !client.client_secret
    || JSON.stringify(client.grant_types) !== JSON.stringify(['client_credentials'])
    || grants.length !== 1 || grants[0].audience !== 'https://hasbai.eu.auth0.com/api/v2/'
    || JSON.stringify([...grants[0].scope].sort()) !== JSON.stringify([...GATEWAY_MANAGEMENT_SCOPES].sort())) {
    throw new Error('Unexpected Gateway management application or grant');
  }
}
