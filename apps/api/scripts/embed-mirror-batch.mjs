#!/usr/bin/env node
/**
 * Batch-embed mirrored skills. Populates `skills.embedding` for every row
 * where `mirrored_from='skills.sh'` and embedding IS NULL, using Voyage AI
 * (same model the publish path uses via src/lib/embeddings.ts).
 *
 * Ports the production logic from src/lib/embeddings.ts + src/jobs/embed-skill.ts
 * into a Node script so we can run it without spinning up the Worker.
 *
 * Required env:
 *   DATABASE_URL       Neon connection string
 *   VOYAGE_API_KEY     Voyage AI key (same secret the Worker uses)
 *   VOYAGE_MODEL       Optional. Defaults to voyage-3.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... node scripts/embed-mirror-batch.mjs
 *   add --dry-run to count candidates without calling Voyage or writing rows
 */
import { neon } from "@neondatabase/serverless";

const DRY = process.argv.includes("--dry-run");
const { DATABASE_URL, VOYAGE_API_KEY, VOYAGE_MODEL = "voyage-3" } = process.env;

if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
if (!DRY && !VOYAGE_API_KEY) { console.error("VOYAGE_API_KEY required (or pass --dry-run)"); process.exit(1); }

const sql = neon(DATABASE_URL);
const EXPECTED_DIM = 1024;
const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";

async function embed(text) {
  const res = await fetch(VOYAGE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${VOYAGE_API_KEY}` },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: "document" }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Voyage API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const e = json.data?.[0]?.embedding;
  if (!e || e.length !== EXPECTED_DIM) {
    throw new Error(`Voyage returned shape len=${e?.length ?? "undefined"}`);
  }
  return e;
}

function toVectorLiteral(vec) { return `[${vec.join(",")}]`; }

const rows = await sql(`
  SELECT id, display_name, short_desc, long_desc_md, tags, category
  FROM skills
  WHERE mirrored_from = 'skills.sh' AND embedding IS NULL
  ORDER BY created_at
`);

console.log(`[embed-mirror-batch] ${rows.length} mirrored skill(s) without embeddings`);
if (DRY) process.exit(0);
if (rows.length === 0) process.exit(0);

let ok = 0, fail = 0;
for (const row of rows) {
  const corpus = [
    row.display_name,
    row.short_desc,
    row.long_desc_md ?? "",
    (row.tags ?? []).join(" "),
    row.category ?? "",
  ].filter(Boolean).join("\n").slice(0, 8000);
  try {
    const vec = await embed(corpus);
    await sql(
      `UPDATE skills SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
      [toVectorLiteral(vec), row.id],
    );
    ok++;
    process.stdout.write(`  ✓ ${row.display_name.slice(0, 40).padEnd(40)} (${ok}/${rows.length})\n`);
  } catch (e) {
    fail++;
    console.warn(`  ✗ ${row.display_name}: ${e.message}`);
    // small backoff on rate-limit-ish errors
    if (/429|rate/i.test(e.message)) await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log(`\n[embed-mirror-batch] ok=${ok} fail=${fail}`);
