/**
 * CI-only shim: emulates the `@neondatabase/serverless` HTTP `neon()` function
 * on top of `pg` (node-postgres) so the production migration scripts under
 * apps/api/scripts/add-*.mjs can run against a local Postgres in CI without
 * any modification.
 *
 * Loaded via `node --import ./scripts/ci/register-neon-shim.mjs <migration.mjs>`
 * (see .github/workflows/migration-idempotency.yml).
 *
 * The migrations only use:
 *   import { neon } from "@neondatabase/serverless";
 *   const sql = neon(DATABASE_URL);
 *   await sql(`CREATE TABLE ...`);                    // raw string
 *   await sql(`SELECT ... FROM ...`);                 // returns array of rows
 *
 * Neon's HTTP `neon()` returns a callable that resolves to an array of row
 * objects (single-statement). We reproduce that contract on top of `pg.Client`,
 * which the migrations need because they execute one statement per call.
 *
 * Out of scope: tagged-template usage, parameterised queries, transactions,
 * `neonConfig` settings. None of the apps/api/scripts/add-*.mjs files use any
 * of those. If a future migration starts using them, extend this shim.
 */
// Use createRequire so we can resolve `pg` via Node's CJS algorithm,
// which respects NODE_PATH. In CI we install pg to /tmp/pgmod/node_modules
// and set NODE_PATH there, instead of polluting the workspace lockfile.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pg = require("pg");
const { Client } = pg;

/**
 * Drop-in replacement for `@neondatabase/serverless`'s `neon()` export.
 *
 * Opens a fresh pg.Client per query, runs the statement, then closes
 * it. See the comment in the function body for why this is preferable
 * to a long-lived connection here.
 */
export function neon(connectionString) {
  // Connect-per-query: each sql() call opens its own pg.Client, runs the
  // query, then closes it. This is slower than keeping a long-lived
  // connection, but it lets the migration script's event loop drain
  // naturally once its top-level await chain finishes — without us
  // having to monkey-patch `process.exit` or rely on `beforeExit`,
  // which doesn't fire while a TCP socket keeps the loop alive.
  //
  // For our use case (a handful of DDL statements per migration, run
  // serially in CI), the overhead of repeated handshakes is irrelevant
  // (<1 s total per migration on localhost).

  // The returned function mirrors Neon's call-style API:
  //   sql("SELECT 1")              -> Promise<rows>
  //   sql`SELECT ${id}`            -> Promise<rows>    (tagged-template; not used here)
  async function sql(strings, ...values) {
    let text;
    const params = [];
    if (typeof strings === "string") {
      text = strings;
    } else if (Array.isArray(strings) && Array.isArray(strings.raw)) {
      // Tagged-template form: re-stitch with $N placeholders.
      let out = "";
      for (let i = 0; i < strings.length; i++) {
        out += strings[i];
        if (i < values.length) {
          params.push(values[i]);
          out += `$${params.length}`;
        }
      }
      text = out;
    } else {
      throw new TypeError(
        `neon-pg-shim: sql() called with unsupported argument type: ${typeof strings}`,
      );
    }

    const client = new Client({ connectionString });
    await client.connect();
    try {
      const res = await client.query(text, params);
      // Neon HTTP returns rows directly as an array (not a {rows} object).
      return res.rows ?? [];
    } finally {
      await client.end().catch(() => {});
    }
  }

  return sql;
}

/** Neon exports `neonConfig` too. Provide a stub so imports don't break. */
export const neonConfig = new Proxy(
  {},
  {
    get() {
      return undefined;
    },
    set() {
      return true;
    },
  },
);

// Default export so both `import x from` and `import { neon } from` work.
export default { neon, neonConfig };
