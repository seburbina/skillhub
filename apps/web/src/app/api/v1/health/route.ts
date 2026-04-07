/**
 * Liveness probe. Used by the Phase 0 smoke test and by uptime checks.
 * Runs on the edge runtime for the cheapest possible cold start.
 */
export const runtime = "edge";

export function GET() {
  return Response.json({
    status: "ok",
    now: new Date().toISOString(),
    version: "0.0.1",
    service: "agent-skill-depot",
  });
}
