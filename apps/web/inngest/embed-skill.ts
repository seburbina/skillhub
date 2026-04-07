/**
 * embed-skill — event-driven job triggered on `skillhub/skill.published`.
 *
 * Reads the skill row, builds a text corpus from display_name + short_desc +
 * long_desc_md + tags, calls Voyage to embed it, writes back to the
 * `skills.embedding` vector(1024) column.
 *
 * The publish route fires the event; this job handles failures + retries
 * independently of the publish request.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { inngest } from "@/lib/inngest";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { embed, toVectorLiteral } from "@/lib/embeddings";

const EventData = z.object({
  skill_id: z.string().uuid(),
});

export const embedSkill = inngest.createFunction(
  { id: "embed-skill", name: "Embed skill for semantic search" },
  { event: "skillhub/skill.published" },
  async ({ event, step }) => {
    const parsed = EventData.safeParse(event.data);
    if (!parsed.success) {
      throw new Error(`Invalid event data: ${parsed.error.message}`);
    }
    const { skill_id } = parsed.data;

    const row = await step.run("load-skill", async () => {
      const rows = await db
        .select()
        .from(skills)
        .where(eq(skills.id, skill_id))
        .limit(1);
      return rows[0] ?? null;
    });

    if (!row) {
      return { skipped: true, reason: "skill not found" };
    }

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

    const embedding = await step.run("voyage-embed", async () =>
      embed(corpus, "document"),
    );

    await step.run("update-embedding", async () => {
      await db.execute(sql`
        UPDATE skills
        SET embedding = ${toVectorLiteral(embedding)}::vector,
            updated_at = NOW()
        WHERE id = ${skill_id}
      `);
    });

    return { ok: true, dim: embedding.length };
  },
);
