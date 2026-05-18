-- Minimal base schema for migration-idempotency CI.
--
-- The apps/api/scripts/add-*.mjs migrations expect a handful of parent
-- tables to exist (so their ALTER TABLE / REFERENCES statements work).
-- In production those tables come from the Drizzle-generated initial
-- migration SQL — but the drizzle/ directory is gitignored (the
-- generated SQL is the contract between the schema and the production
-- DB, not part of the repo).
--
-- This file is the smallest subset of that schema needed to exercise
-- the add-*.mjs files. It is intentionally minimal: only the columns
-- referenced by add-*.mjs migrations (directly or via FK) are present.
-- If a new add-*.mjs migration references a new column or table, add
-- it here.
--
-- Used by .github/workflows/migration-idempotency.yml.

-- Extensions the migrations rely on. The pgvector/pgvector:pg16 image
-- ships pgcrypto, citext, and vector. CREATE EXTENSION IF NOT EXISTS
-- is idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext UNIQUE NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  api_key_hash   text NOT NULL DEFAULT '',
  api_key_prefix varchar(16) NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Skills + versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS skills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE NOT NULL,
  author_agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  display_name       text NOT NULL,
  short_desc         text NOT NULL DEFAULT '',
  install_count      bigint NOT NULL DEFAULT 0,
  download_count     bigint NOT NULL DEFAULT 0,
  reputation_score   numeric(8,4) NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id      uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver        text NOT NULL,
  content_hash  text,
  published_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Telemetry + moderation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id     uuid REFERENCES skills(id) ON DELETE SET NULL,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  reason       text NOT NULL,
  admin_notes  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
