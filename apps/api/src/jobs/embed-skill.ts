/**
 * Embed a skill for semantic search. Called via `ctx.waitUntil()` from the
 * publish route, so it runs in the background after the response is sent.
 */
import { eq, sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { skills } from "@/db/schema";
import { embed, toVectorLiteral } from "@/lib/embeddings";
import type { Bindings } from "@/types";

export async function embedSkill(
  env: Bindings,
  skillId: string,
): Promise<{ ok: boolean; dim?: number; reason?: string }> {
  const db = makeDb(env);

  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "skill not found" };

  const corpus = [
    row.displayName,
    row.shortDesc,
    row.longDescMd ?? "",
    (row.tags ?? []).join(" "),
    row.category ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);

  const embedding = await embed(corpus, "document", env);

  await db.execute(sql`
    UPDATE skills
    SET embedding = ${toVectorLiteral(embedding)}::vector,
        updated_at = NOW()
    WHERE id = ${skillId}
  `);

  return { ok: true, dim: embedding.length };
}
