/**
 * Agent Skill Depot — Drizzle schema (migration #1).
 *
 * This file defines EVERY table the system will ever need, including the
 * reserved monetization tables (`subscriptions`, `entitlements`, plus
 * `users.plan`, `users.stripe_customer_id`, `skills.price_cents`, and the
 * `public_paid` visibility value). Those columns/values are unused in the MVP
 * but exist from day 1 so that enabling monetization later is a config
 * change, not a schema migration.
 *
 * Conventions:
 *   - Every table has `id uuid PK` (default `gen_random_uuid()`), `created_at`,
 *     `updated_at`.
 *   - Money is integer cents, never floats.
 *   - Use pgvector's `vector(1024)` for embeddings (HNSW index).
 *   - `citext` used for case-insensitive email uniqueness.
 *
 * Required extensions (created in migration SQL header):
 *   - pgcrypto  — for gen_random_uuid()
 *   - citext    — for case-insensitive email
 *   - vector    — pgvector for semantic search
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Custom column types
// ---------------------------------------------------------------------------

/** Case-insensitive text (citext extension). */
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** pgvector fixed-dimension vector column factory. */
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value: number[]) => `[${value.join(",")}]`,
    fromDriver: (value: string) =>
      value.slice(1, -1).split(",").map(Number),
  });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userPlanEnum = pgEnum("user_plan", [
  "free",
  "pro",
  "enterprise",
]);

export const skillVisibilityEnum = pgEnum("skill_visibility", [
  "public_free",
  "public_paid", // reserved — unused in MVP
  "unlisted",
  "private",    // reserved — unused in MVP
]);

export const invocationOutcomeEnum = pgEnum("invocation_outcome", [
  "success",
  "partial",
  "failure",
  "unknown",
]);

export const scrubStatusEnum = pgEnum("scrub_status", [
  "clean",
  "warn",
  "block",
]);

export const moderationStatusEnum = pgEnum("moderation_status", [
  "open",
  "reviewing",
  "resolved",
  "dismissed",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
]);

export const entitlementSourceEnum = pgEnum("entitlement_source", [
  "purchase",
  "subscription",
  "gift",
  "author",
]);

export const tierEnum = pgEnum("contributor_tier", [
  "unranked",
  "bronze",
  "silver",
  "gold",
  "platinum",
]);

// ---------------------------------------------------------------------------
// Core identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: citext("email").notNull().unique(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedMethod: text("verified_method"), // 'email_only' | 'email+x'
    xHandle: text("x_handle"),
    plan: userPlanEnum("plan").notNull().default("free"),
    // MONETIZATION-RESERVED — unused in MVP
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description"),
    apiKeyHash: text("api_key_hash").notNull(),
    apiKeyPrefix: varchar("api_key_prefix", { length: 16 }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    reputationScore: numeric("reputation_score", { precision: 8, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    apiKeyHashIdx: index("agents_api_key_hash_idx").on(t.apiKeyHash),
    ownerIdx: index("agents_owner_idx").on(t.ownerUserId),
    ownerNameUnq: unique("agents_owner_name_unq").on(t.ownerUserId, t.name),
  }),
);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").notNull().unique(),
    authorAgentId: uuid("author_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    displayName: text("display_name").notNull(),
    shortDesc: text("short_desc").notNull(),
    longDescMd: text("long_desc_md"),
    currentVersionId: uuid("current_version_id"),
    visibility: skillVisibilityEnum("visibility")
      .notNull()
      .default("public_free"),
    // MONETIZATION-RESERVED — always 0 in MVP
    priceCents: integer("price_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    category: text("category"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    embedding: vector(1024)("embedding").$type<number[]>(),
    downloadCount: bigint("download_count", { mode: "number" })
      .notNull()
      .default(0),
    installCount: bigint("install_count", { mode: "number" })
      .notNull()
      .default(0),
    starCount: integer("star_count").notNull().default(0),
    reputationScore: numeric("reputation_score", { precision: 8, scale: 4 })
      .notNull()
      .default("0"),
    licenseSpdx: text("license_spdx").notNull().default("MIT"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    slugIdx: index("skills_slug_idx").on(t.slug),
    authorIdx: index("skills_author_idx").on(t.authorAgentId),
    visibilityIdx: index("skills_visibility_idx").on(t.visibility),
    categoryIdx: index("skills_category_idx").on(t.category),
    // HNSW vector index is created in the raw SQL migration — Drizzle can't express it yet.
  }),
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    semver: text("semver").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    r2Key: text("r2_key").notNull(),
    /** SHA-256 digest in `sha256:{hex}` format for .well-known discovery spec. */
    sha256Digest: text("sha256_digest"),
    githubCommitSha: text("github_commit_sha"),
    changelogMd: text("changelog_md"),
    scrubReportId: uuid("scrub_report_id"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    yankedAt: timestamp("yanked_at", { withTimezone: true }),
  },
  (t) => ({
    skillSemverUnq: unique("skill_versions_skill_semver_unq").on(
      t.skillId,
      t.semver,
    ),
    skillIdx: index("skill_versions_skill_idx").on(t.skillId),
  }),
);

// ---------------------------------------------------------------------------
// Telemetry / ranking
// ---------------------------------------------------------------------------

export const invocations = pgTable(
  "invocations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    invokingAgentId: uuid("invoking_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    followUpIterations: integer("follow_up_iterations"),
    outcome: invocationOutcomeEnum("outcome"),
    rating: smallint("rating"), // -1 | 0 | 1
    clientMeta: jsonb("client_meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    skillIdx: index("invocations_skill_idx").on(t.skillId),
    agentIdx: index("invocations_agent_idx").on(t.invokingAgentId),
    startedAtIdx: index("invocations_started_at_idx").on(t.startedAt),
  }),
);

export const ratings = pgTable(
  "ratings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    invocationId: uuid("invocation_id")
      .notNull()
      .unique()
      .references(() => invocations.id, { onDelete: "cascade" }),
    raterAgentId: uuid("rater_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    value: smallint("value").notNull(), // -1 | 1
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const scrubReports = pgTable("scrub_reports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, {
    onDelete: "cascade",
  }),
  regexFindings: jsonb("regex_findings"),
  llmFindings: jsonb("llm_findings"),
  serverRescanFindings: jsonb("server_rescan_findings"),
  status: scrubStatusEnum("status").notNull(),
  reviewedByUser: boolean("reviewed_by_user").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// MONETIZATION-RESERVED tables (unused in MVP, created day 1)
// ---------------------------------------------------------------------------

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  status: subscriptionStatusEnum("status").notNull(),
  plan: userPlanEnum("plan").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    source: entitlementSourceEnum("source").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userSkillUnq: unique("entitlements_user_skill_unq").on(t.userId, t.skillId),
  }),
);

// ---------------------------------------------------------------------------
// Moderation / abuse
// ---------------------------------------------------------------------------

export const moderationFlags = pgTable("moderation_flags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  targetType: text("target_type").notNull(), // 'skill' | 'agent' | 'user'
  targetId: uuid("target_id").notNull(),
  reporterUserId: uuid("reporter_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  reason: text("reason").notNull(),
  status: moderationStatusEnum("status").notNull().default("open"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.windowStart] }),
  }),
);

// ---------------------------------------------------------------------------
// Stats & gamification (refreshed hourly by the Worker scheduled() handler)
// ---------------------------------------------------------------------------

/**
 * `user_stats` is actually a materialized view in Postgres. Drizzle doesn't
 * natively model materialized views, so we declare it as a regular table here
 * for type inference, and the raw SQL migration creates it as a matview.
 */
export const userStats = pgTable("user_stats", {
  userId: uuid("user_id").primaryKey(),
  totalSkillsPublished: integer("total_skills_published").notNull().default(0),
  totalInstalls: bigint("total_installs", { mode: "number" })
    .notNull()
    .default(0),
  totalDownloads: bigint("total_downloads", { mode: "number" })
    .notNull()
    .default(0),
  totalInvocationsReceived: bigint("total_invocations_received", {
    mode: "number",
  })
    .notNull()
    .default(0),
  bestSkillScore: numeric("best_skill_score", { precision: 8, scale: 4 })
    .notNull()
    .default("0"),
  avgSkillScore: numeric("avg_skill_score", { precision: 8, scale: 4 })
    .notNull()
    .default("0"),
  iterSignalAvg: numeric("iter_signal_avg", { precision: 8, scale: 4 })
    .notNull()
    .default("0"),
  contributorScore: numeric("contributor_score", { precision: 8, scale: 4 })
    .notNull()
    .default("0"),
  tier: tierEnum("tier").notNull().default("unranked"),
  firstPublishAt: timestamp("first_publish_at", { withTimezone: true }),
  lastPublishAt: timestamp("last_publish_at", { withTimezone: true }),
  weeklyDelta: numeric("weekly_delta", { precision: 8, scale: 4 })
    .notNull()
    .default("0"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const skillStatsDaily = pgTable(
  "skill_stats_daily",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // ISO date string YYYY-MM-DD
    downloads: integer("downloads").notNull().default(0),
    installs: integer("installs").notNull().default(0),
    invocations: integer("invocations").notNull().default(0),
    upRatings: integer("up_ratings").notNull().default(0),
    downRatings: integer("down_ratings").notNull().default(0),
    medianIter: numeric("median_iter", { precision: 8, scale: 2 }),
    medianDurationMs: integer("median_duration_ms"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillId, t.date] }),
  }),
);

export const leaderboardSnapshots = pgTable(
  "leaderboard_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    snapshotDate: text("snapshot_date").notNull(), // ISO date
    kind: text("kind").notNull(), // 'users' | 'skills'
    window: text("window").notNull(), // 'week' | 'month' | 'all'
    rank: integer("rank").notNull(),
    subjectId: uuid("subject_id").notNull(),
    score: numeric("score", { precision: 10, scale: 4 }).notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    snapshotIdx: index("leaderboard_snapshots_date_kind_idx").on(
      t.snapshotDate,
      t.kind,
      t.window,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Config (ranking + contributor score weights)
// ---------------------------------------------------------------------------

export const rankingWeights = pgTable("ranking_weights", {
  id: integer("id").primaryKey().default(1), // single-row table
  iter: numeric("iter", { precision: 5, scale: 4 }).notNull().default("0.40"),
  rating: numeric("rating", { precision: 5, scale: 4 }).notNull().default("0.25"),
  adoption: numeric("adoption", { precision: 5, scale: 4 }).notNull().default("0.20"),
  speed: numeric("speed", { precision: 5, scale: 4 }).notNull().default("0.10"),
  recency: numeric("recency", { precision: 5, scale: 4 }).notNull().default("0.05"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const contributorScoreWeights = pgTable("contributor_score_weights", {
  id: integer("id").primaryKey().default(1), // single-row table
  effort: numeric("effort", { precision: 5, scale: 2 }).notNull().default("8.00"),
  adoption: numeric("adoption", { precision: 5, scale: 2 }).notNull().default("4.00"),
  reach: numeric("reach", { precision: 5, scale: 2 }).notNull().default("2.00"),
  quality: numeric("quality", { precision: 5, scale: 2 }).notNull().default("6.00"),
  consistency: numeric("consistency", { precision: 5, scale: 2 }).notNull().default("5.00"),
  recency: numeric("recency", { precision: 5, scale: 2 }).notNull().default("3.00"),
  recencyDecayDays: integer("recency_decay_days").notNull().default(45),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Type exports for use elsewhere
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type NewSkillVersion = typeof skillVersions.$inferInsert;
export type Invocation = typeof invocations.$inferSelect;
export type NewInvocation = typeof invocations.$inferInsert;
export type Rating = typeof ratings.$inferSelect;
export type ScrubReport = typeof scrubReports.$inferSelect;
export type NewScrubReport = typeof scrubReports.$inferInsert;
export type UserStats = typeof userStats.$inferSelect;
