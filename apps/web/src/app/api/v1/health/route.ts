import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Liveness probe. Used by the Phase 0 smoke test and by uptime checks.
 * Does NOT touch the DB intentionally — keeps the probe cheap and
 * independent of DB availability.
 */
export function GET() {
  return NextResponse.json({
    status: "ok",
    now: new Date().toISOString(),
    version: "0.0.1",
    service: "agent-skill-depot",
  });
}
