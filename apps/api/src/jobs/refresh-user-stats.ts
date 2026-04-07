import { sql } from "drizzle-orm";
import { makeDb } from "@/db";
import type { Bindings } from "@/types";

export async function refreshUserStats(env: Bindings): Promise<void> {
  const db = makeDb(env);
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats`);
}
