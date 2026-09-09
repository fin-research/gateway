export interface AccountSummary {
  name: string;
  department: string;
}

export interface SiteAuthorization {
  department?: string;
  name: string;
  roles: import('./server/auth0-directory').Auth0Role[];
  permissions: string[];
  mode: import('./permissions').AuthorizationMode;
  picture: string;
}

/** One verified site identity and one application authorization result. */
export interface SiteIdentity {
  readonly id: string;
  readonly email: string;
  readonly auth0Id: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  authorization?: SiteAuthorization;
}

/** Project business responsibility uses the Auth0 ID directly; this is a presentation DTO. */
export function financingPersonView(identity: SiteIdentity | null) {
  if (!identity?.authorization || !identity.auth0Id) return null;
  return { id: identity.auth0Id, personId: identity.auth0Id, email: identity.email,
    personName: identity.authorization.name, roles: identity.authorization.roles,
    role: identity.authorization.roles.map((role) => role.name).join('、'),
    picture: identity.authorization.picture };
}

/** Authentication metadata and business authorization remain server-side. */
export function publicIdentity(identity: SiteIdentity | null) {
  return identity ? { id: identity.id, email: identity.email, auth0Id: identity.auth0Id } : null;
}

/** A presentation snapshot, never a credential or a server authorization input. */
export interface ClientSessionData {
  user: ReturnType<typeof publicIdentity>;
  account: AccountSummary | null;
  roles: { id: string; name: string }[];
  permissions: string[];
  expiresAt: number | null;
}

export function publicSession(identity: SiteIdentity | null): ClientSessionData {
  const authorization = identity?.authorization;
  return {
    user: publicIdentity(identity),
    account: authorization ? { name: authorization.name, department: authorization.department ?? '' } : null,
    roles: authorization?.roles.map(({ id, name }) => ({ id, name })) ?? [],
    permissions: authorization?.permissions ?? [],
    expiresAt: identity?.expiresAt ?? null,
  };
}
