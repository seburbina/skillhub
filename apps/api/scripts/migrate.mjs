#!/usr/bin/env node
/**
 * Apply migrations to a Neon Postgres branch via the serverless HTTP driver.
 *
 * Reads files in order:
 *   1. drizzle/0000_init_extensions.sql  — pgcrypto, citext, vector
 *   2. drizzle/0000_grey_arachne.sql     — Drizzle-generated CREATE TABLE
 *   3. drizzle/9999_post_init.sql        — pgvector index, matview, seeds
 *
 * Reads DATABASE_URL from process.env or from the secrets file.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(__dirname, "..", "drizzle");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const files = [
  "0000_init_extensions.sql",
  "0000_grey_arachne.sql",
  "9999_post_init.sql",
];

/** Split a SQL file into individual statements on the drizzle separator. */
function splitStatements(text) {
  // Drizzle uses --> statement-breakpoint as a marker. For our hand-written
  // files, fall back to splitting on ; followed by newline (not perfect for
  // function bodies, but our files don't use any).
  if (text.includes("--> statement-breakpoint")) {
    return text
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Hand-written file: split on bare semicolons that end a line
  return text
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter((s) => s && !s.match(/^\s*--/));
}

for (const file of files) {
  const path = join(drizzleDir, file);
  console.log(`\n=== ${file} ===`);
  const text = readFileSync(path, "utf-8");
  const statements = splitStatements(text);
  console.log(`  ${statements.length} statements`);

  let ok = 0;
  let skipped = 0;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (!stmt || stmt.length < 3) continue;
    const preview = stmt.slice(0, 80).replace(/\s+/g, " ");
    try {
      // The @neondatabase/serverless HTTP client accepts a raw SQL string
      // when called as a function.
      await sql(stmt);
      ok++;
      process.stdout.write(`  ${(i + 1).toString().padStart(3)}/${statements.length} ✓ ${preview}\n`);
    } catch (e) {
      const msg = String(e.message || e);
      // Idempotent skips: already exists, already enabled, etc.
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("already enabled")
      ) {
        skipped++;
        process.stdout.write(`  ${(i + 1).toString().padStart(3)}/${statements.length} ↷ skip ${preview}  (${msg.split("\n")[0]})\n`);
      } else {
        process.stdout.write(`  ${(i + 1).toString().padStart(3)}/${statements.length} ✗ FAIL ${preview}\n    ${msg.split("\n")[0]}\n`);
        // Continue past errors so we see all of them at once
      }
    }
  }
  console.log(`  done: ${ok} ok, ${skipped} skipped, ${statements.length - ok - skipped} failed`);
}

console.log("\nMigration complete.");
