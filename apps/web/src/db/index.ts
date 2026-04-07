/**
 * Postgres client wrapper for Drizzle ORM.
 *
 * **Lazy-initialized.** The postgres client is constructed on first access,
 * not at module load. This is critical for serverless cold-starts: an
 * eagerly-constructed client with a placeholder URL ("postgres://invalid")
 * causes the postgres driver to attempt DNS resolution at init time, which
 * hangs the function for the full connect_timeout window before returning
 * any response. Lazy-init means the function loads instantly even when
 * DATABASE_URL is missing or wrong.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

let _client: Sql | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

function getClient(): Sql {
  if (_client) return _client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in Vercel project env vars.",
    );
  }
  _client = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Neon pooled connections don't support prepared statements
  });
  return _client;
}

/**
 * Lazy Drizzle proxy. Calling any method (`db.select`, `db.insert`,
 * `db.execute`, etc.) initializes the postgres client on first use.
 *
 * Routes import `db` like normal — the proxy looks the same as a real
 * Drizzle database from the call site.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop: string | symbol) {
    if (!_db) {
      _db = drizzle(getClient(), { schema, logger: false });
    }
    return Reflect.get(_db, prop);
  },
});

export { schema };
export type Db = PostgresJsDatabase<typeof schema>;
