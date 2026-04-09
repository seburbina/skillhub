/**
 * /.well-known/agent-skills/ — Agent Skills Discovery (RFC 8615)
 *
 * Implements the Cloudflare Agent Skills Discovery RFC, which is being
 * adopted into the official Agent Skills spec via agentskills/agentskills#254.
 *
 * Serves an index.json that enumerates every public skill on AgentSkillDepot.
 * Any spec-compliant agent can fetch this index and install skills directly.
 *
 * Spec: https://github.com/cloudflare/agent-skills-discovery-rfc
 * PR:   https://github.com/agentskills/agentskills/pull/254
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { makeDb } from "@/db";
import type { Env } from "@/types";

export const wellKnown = new Hono<Env>();

// CORS on all .well-known routes — browser-based agents and CLI tools may
// fetch from any origin (spec recommends CORS for browser-based clients).
wellKnown.use("*", cors({ origin: "*" }));

const SCHEMA_URI = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

interface SkillIndexEntry {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: string;
  digest: string;
}

// ---------------------------------------------------------------------------
// GET /.well-known/agent-skills/index.json
// ---------------------------------------------------------------------------

wellKnown.get("/index.json", async (c) => {
  const db = makeDb(c.env);

  // Fetch all public, non-deleted skills with their latest non-yanked version
  const rows = await db.execute<{
    slug: string;
    short_desc: string;
    r2_key: string;
    sha256_digest: string | null;
    content_hash: string;
    size_bytes: number | null;
  }>(sql`
    SELECT
      s.slug,
      s.short_desc,
      sv.r2_key,
      sv.sha256_digest,
      sv.content_hash,
      sv.size_bytes
    FROM skills s
    INNER JOIN skill_versions sv ON sv.id = s.current_version_id
    WHERE s.deleted_at IS NULL
      AND s.visibility IN ('public_free', 'public_paid')
      AND sv.yanked_at IS NULL
  `);

  const skills: SkillIndexEntry[] = rows.rows.map((r) => ({
    name: r.slug,
    // Skills on AgentSkillDepot are archives (.skill ZIP bundles)
    // containing SKILL.md + scripts/ + references/ + assets/
    type: "archive" as const,
    description: r.short_desc.slice(0, 1024),
    // Download URL — publicly accessible, no auth needed for discovery.
    // Agents that want telemetry tracking should use the /v1/ API instead,
    // but for .well-known compliance we serve a direct download path.
    // Serve as .zip — our archives are ZIP files (.skill is a ZIP).
    // The spec says clients determine format from Content-Type header,
    // falling back to file extension. We serve application/zip.
    url: `/.well-known/agent-skills/${r.slug}.zip`,
    // SHA-256 digest for integrity verification per the spec.
    // Prefer the spec-format sha256_digest column; fall back to content_hash
    // (which may be a different hash algo from the publish pipeline).
    digest: r.sha256_digest ?? `sha256:${r.content_hash}`,
  }));

  return c.json(
    {
      $schema: SCHEMA_URI,
      skills,
    },
    200,
    {
      "Content-Type": "application/json; charset=utf-8",
      // Cache for 5 minutes — skills don't change that frequently
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  );
});

// ---------------------------------------------------------------------------
// GET /.well-known/agent-skills/:slug.tar.gz — direct skill download
// ---------------------------------------------------------------------------

wellKnown.get("/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!filename) {
    return c.json({ error: "not_found" }, 404);
  }

  // Extract slug from filename — supports .tar.gz and .zip
  let slug: string;
  if (filename.endsWith(".tar.gz")) {
    slug = filename.slice(0, -7);
  } else if (filename.endsWith(".zip")) {
    slug = filename.slice(0, -4);
  } else {
    return c.json({ error: "not_found" }, 404);
  }

  if (!slug) {
    return c.json({ error: "not_found" }, 404);
  }

  const db = makeDb(c.env);

  // Find the skill and its current version's R2 key
  const rows = await db.execute<{
    r2_key: string;
    download_count: number;
    skill_id: string;
  }>(sql`
    SELECT
      sv.r2_key,
      s.download_count,
      s.id AS skill_id
    FROM skills s
    INNER JOIN skill_versions sv ON sv.id = s.current_version_id
    WHERE s.slug = ${slug}
      AND s.deleted_at IS NULL
      AND s.visibility IN ('public_free', 'public_paid')
      AND sv.yanked_at IS NULL
    LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  // Bump download count (fire-and-forget)
  c.executionCtx.waitUntil(
    db.execute(sql`
      UPDATE skills
      SET download_count = download_count + 1
      WHERE id = ${row.skill_id}
    `).catch((e) => console.error("[well-known download] count bump failed:", e)),
  );

  // Fetch from R2 and stream to client.
  // R2 objects are ZIP archives (.skill files). Serve as application/zip
  // regardless of the requested extension — the spec says clients should
  // determine format from Content-Type.
  const r2Object = await c.env.SKILLS_BUCKET.get(row.r2_key);
  if (!r2Object) {
    console.error(`[well-known download] R2 key missing: ${row.r2_key}`);
    return c.json({ error: "not_found" }, 404);
  }

  return new Response(r2Object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      // Cache the binary for 1 hour — version changes are infrequent
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
});
