/**
 * Postgres client wrapper for Drizzle ORM.
 *
 * Uses the `postgres` driver in serverless-friendly mode. Neon serverless
 * branches use a pooled connection string; the `postgres` driver handles
 * pooling internally with `max: 1` per edge invocation.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  // Allow build-time bundling without a DB connection; fail loudly at runtime.
  if (process.env.NODE_ENV !== "production") {
    console.warn("[db] DATABASE_URL is not set; queries will throw at runtime.");
  }
}

/** Shared postgres client — one per edge invocation. */
const client = postgres(DATABASE_URL ?? "postgres://invalid", {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // Neon pooled connections don't support prepared statements
});

export const db = drizzle(client, { schema, logger: false });
export { schema };
export type Db = typeof db;
