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
 *   VOYAGE_RPM         Optional. Defaults to 3 (free tier). Set to 300+
 *                      once a payment method is on file.
 *
 * NOTE: If you've deployed the Workers AI binding (wrangler.toml [ai]),
 * prefer calling `POST /v1/admin/reembed-all` on the Worker instead — it
 * uses env.AI and is free. This Node script is the Voyage fallback for
 * contexts where the Worker isn't reachable.
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

// Voyage rate limits: paid tier is generous; free tier is 3 RPM / 10K TPM.
// Override with VOYAGE_RPM env (e.g. 300 for paid).
const RPM = Number(process.env.VOYAGE_RPM) || 3;
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM) + 500; // +500ms safety margin
console.log(`[embed-mirror-batch] pacing at ${RPM} RPM (${MIN_INTERVAL_MS}ms between requests)`);

let ok = 0, fail = 0;
let lastCallAt = 0;
for (const row of rows) {
  const corpus = [
    row.display_name,
    row.short_desc,
    row.long_desc_md ?? "",
    (row.tags ?? []).join(" "),
    row.category ?? "",
  ].filter(Boolean).join("\n").slice(0, 8000);

  // Rate-limit: wait until MIN_INTERVAL_MS has passed since the last call.
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let attempt = 0;
  while (attempt < 5) {
    attempt++;
    lastCallAt = Date.now();
    try {
      const vec = await embed(corpus);
      await sql(
        `UPDATE skills SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
        [toVectorLiteral(vec), row.id],
      );
      ok++;
      process.stdout.write(`  ✓ ${row.display_name.slice(0, 40).padEnd(40)} (${ok}/${rows.length})\n`);
      break;
    } catch (e) {
      if (/429|rate/i.test(e.message) && attempt < 5) {
        const backoff = Math.min(60_000, MIN_INTERVAL_MS * attempt * 2);
        process.stdout.write(`  … 429 on ${row.display_name}, backing off ${backoff}ms (retry ${attempt})\n`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      fail++;
      console.warn(`  ✗ ${row.display_name}: ${e.message.slice(0, 150)}`);
      break;
    }
  }
}
console.log(`\n[embed-mirror-batch] ok=${ok} fail=${fail}`);
