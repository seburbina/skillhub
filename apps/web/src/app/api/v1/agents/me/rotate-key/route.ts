import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { generateApiKey, requireAgent } from "@/lib/auth";
import { withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Rotate the agent's API key.
 *
 * MVP: atomic swap. The old key is invalidated immediately. A future
 * version should keep the old key valid for 24h (dual-key window) to avoid
 * downtime during rotation.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  const { raw: apiKey, hash, prefix } = generateApiKey();

  await db
    .update(agents)
    .set({
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agent.id));

  return NextResponse.json({
    api_key: apiKey,
    api_key_prefix: prefix,
    rotated_at: new Date().toISOString(),
  });
});
