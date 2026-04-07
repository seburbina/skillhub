/**
 * refresh-user-stats — hourly REFRESH of the user_stats materialized view.
 *
 * The view is created in `drizzle/9999_post_init.sql`. This job runs
 * REFRESH MATERIALIZED VIEW CONCURRENTLY so reads are never blocked.
 *
 * Phase 2 extension: after the refresh, compute contributor_score + tier
 * for each row and write them back (the matview definition currently
 * leaves those columns at zero for us to fill in).
 */
import { sql } from "drizzle-orm";
import { inngest } from "@/lib/inngest";
import { db } from "@/db";

export const refreshUserStats = inngest.createFunction(
  { id: "refresh-user-stats", name: "Refresh user_stats matview" },
  { cron: "37 * * * *" }, // hourly at :37
  async ({ step }) => {
    await step.run("refresh-matview", async () => {
      await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats`);
    });
    return { ok: true };
  },
);
