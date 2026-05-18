/**
 * CI-only bootstrap: registers the neon-shim-loader ESM hook so subsequent
 * imports of `@neondatabase/serverless` resolve to the pg-backed shim.
 *
 * Used as `node --import ./scripts/ci/register-neon-shim.mjs <migration.mjs>`
 * by .github/workflows/migration-idempotency.yml — never in production.
 */
import { register } from "node:module";

// `import.meta.url` is already a file:// URL — pass it through as-is so
// `register()` can resolve the loader relative to this file's location.
register("./neon-shim-loader.mjs", import.meta.url);
