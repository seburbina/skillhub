/**
 * Inngest webhook + function registration.
 *
 * Inngest Cloud (or the local dev server) POSTs here to invoke our jobs.
 * Register every durable function here; the serve() adapter handles
 * signing-key validation, payload parsing, and retries.
 */
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { recomputeRankings } from "../../../../inngest/recompute-rankings";
import { refreshUserStats } from "../../../../inngest/refresh-user-stats";
import { embedSkill } from "../../../../inngest/embed-skill";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [recomputeRankings, refreshUserStats, embedSkill],
});
