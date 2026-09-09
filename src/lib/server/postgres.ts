import { Client } from "pg";

export type DatabaseClient = Pick<Client, "query">;
export type BondDatabaseClient = DatabaseClient;

export async function withPostgres<T>(
  connectionString: string | undefined,
  applicationName: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  if (!connectionString) {
    throw new Error("Hyperdrive binding HYPERDRIVE is unavailable");
  }
  const client = new Client({
    connectionString,
    application_name: applicationName,
    keepAlive: true,
  });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
