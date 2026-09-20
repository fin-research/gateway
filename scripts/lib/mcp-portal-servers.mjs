/** Project response-only metadata away; preserve portal-specific capability overrides. */
export function portalServerSettings(server) {
  const result = { server_id: server.server_id ?? server.id, on_behalf: server.on_behalf ?? false, default_disabled: server.default_disabled ?? false };
  for (const key of ['updated_tools', 'updated_prompts']) {
    if (server[key]?.length) result[key] = server[key].map(item => ({ name: item.name,
      ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
      ...(item.portal_alias !== undefined || item.alias !== undefined ? { alias: item.portal_alias ?? item.alias } : {}),
      ...(item.portal_description !== undefined || item.description !== undefined ? { description: item.portal_description ?? item.description } : {}),
    }));
  }
  return result;
}
