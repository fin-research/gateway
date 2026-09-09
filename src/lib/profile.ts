export interface AccountProfile {
  name: string;
  email: string;
  emailVerified: boolean;
  roles: { name: string; description: string }[];
  permissions: { name: string; description: string; resource: string }[];
}
