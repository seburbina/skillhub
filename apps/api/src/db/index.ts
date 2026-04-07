/**
 * Drizzle DB client wired to Neon's serverless HTTP driver.
 *
 * `@neondatabase/serverless` works on Cloudflare Workers (and any other
 * fetch-only runtime) because it talks to Neon over HTTPS instead of using
 * raw Postgres TCP. Drizzle's `neon-http` adapter sits on top of it.
 *
 * Pattern:
 *   const db = makeDb(c.env);
 *   const rows = await db.select().from(skills).where(eq(skills.slug, slug));
 *
 * `makeDb` is called per-request (cheap — just builds a thin object); the
 * underlying neon() client itself caches connection state inside the
 * Cloudflare isolate, so successive requests reuse warm connections.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

export function makeDb(env: { DATABASE_URL: string }): Db {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  const sql = neon(env.DATABASE_URL);
  return drizzle(sql, { schema, logger: false });
}

export { schema };
