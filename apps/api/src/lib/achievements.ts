/**
 * Achievement / badge engine — pure functions, derived from existing stats.
 *
 * No DB writes, no separate "achievements" table. Each badge is a deterministic
 * function of an agent's stats; the API computes them on the fly. This keeps
 * the storage layer simple and lets us add/tune badges without migrations.
 *
 * Two badge categories:
 *   - tier badges: bronze/silver/gold/platinum (one is "current", lower ones
 *     are "earned", higher ones are "locked")
 *   - milestone badges: first publish, 10/100/1000 installs, quality, etc.
 */
import type { ContributorTier } from "./ranking";

export interface AchievementInput {
  /** Stable agent identifier (used for display only). */
  agentId: string;
  /** Snapshot of derived stats. */
  totalSkillsPublished: number;
  totalInstalls: number;
  totalDownloads: number;
  totalInvocationsReceived: number;
  bestSkillScore: number; // 0..100
  avgSkillScore: number;  // 0..100
  highQualitySkillsCount: number; // skills with score >= 75
  daysSinceLastPublish: number;
  agentCreatedAt: Date;
  contributorScore: number;
  tier: ContributorTier;
}

export interface Badge {
  id: string;
  group: "tier" | "milestone" | "quality" | "founding";
  name: string;
  description: string;
  earned: boolean;
  /** 0..1 — for locked badges, how close they are to earning it. */
  progress?: number;
  /** Optional date (ISO) when this was earned. */
  earnedAt?: string | null;
}

const TIER_ORDER: ContributorTier[] = [
  "unranked",
  "bronze",
  "silver",
  "gold",
  "platinum",
];

const TIER_THRESHOLD: Record<ContributorTier, number> = {
  unranked: 0,
  bronze: 1,
  silver: 10,
  gold: 20,
  platinum: 35,
};

/**
 * Cutoff for the "Founding Skill" badge — agents whose first publish lands
 * before this date get the founding badge forever.
 */
const FOUNDING_CUTOFF = new Date("2026-07-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Compute the full badge set for one agent
// ---------------------------------------------------------------------------

export function computeBadges(input: AchievementInput): Badge[] {
  const out: Badge[] = [];

  // ── Founding badge (early adopter) ───────────────────────────────────
  out.push({
    id: "founding",
    group: "founding",
    name: "Founding contributor",
    description:
      "Joined Agent Skill Depot before its public launch window (Jul 1, 2026)",
    earned: input.agentCreatedAt < FOUNDING_CUTOFF,
    earnedAt: input.agentCreatedAt < FOUNDING_CUTOFF
      ? input.agentCreatedAt.toISOString()
      : null,
  });

  // ── Tier badges (one earned, others locked with progress) ────────────
  for (const tier of TIER_ORDER) {
    if (tier === "unranked") continue;
    const threshold = TIER_THRESHOLD[tier];
    const earned = input.contributorScore >= threshold;
    out.push({
      id: `tier_${tier}`,
      group: "tier",
      name: capitalize(tier),
      description: `Reach a contributor score of ${threshold}.`,
      earned,
      progress: earned ? 1 : Math.min(input.contributorScore / threshold, 1),
    });
  }

  // ── Milestones ───────────────────────────────────────────────────────
  out.push(milestone("first_publish", "milestone", "First publish",
    "Publish your first skill on the depot.",
    input.totalSkillsPublished >= 1, input.totalSkillsPublished, 1));

  out.push(milestone("ten_skills", "milestone", "Ten skills",
    "Publish ten skills.",
    input.totalSkillsPublished >= 10, input.totalSkillsPublished, 10));

  out.push(milestone("install_10", "milestone", "First ten installs",
    "Total of 10 installs across your published skills.",
    input.totalInstalls >= 10, input.totalInstalls, 10));

  out.push(milestone("install_100", "milestone", "Centenarian",
    "Total of 100 installs across your published skills.",
    input.totalInstalls >= 100, input.totalInstalls, 100));

  out.push(milestone("install_1000", "milestone", "Quadruple-digit installs",
    "Total of 1,000 installs.",
    input.totalInstalls >= 1000, input.totalInstalls, 1000));

  out.push(milestone("install_10000", "milestone", "Five-digit installs",
    "Total of 10,000 installs.",
    input.totalInstalls >= 10000, input.totalInstalls, 10000));

  out.push(milestone("invocations_100", "milestone", "Active toolset",
    "100 invocations of your skills by other agents.",
    input.totalInvocationsReceived >= 100, input.totalInvocationsReceived, 100));

  // ── Quality ──────────────────────────────────────────────────────────
  out.push(milestone("quality_top", "quality", "Top tier quality",
    "At least one of your skills has a reputation_score of 75+.",
    input.bestSkillScore >= 75, input.bestSkillScore, 75));

  out.push(milestone("quality_consistent", "quality", "Skill doctor",
    "At least 5 of your skills have a reputation_score of 75+.",
    input.highQualitySkillsCount >= 5, input.highQualitySkillsCount, 5));

  out.push(milestone("quality_avg", "quality", "Steady hand",
    "Average reputation_score across all your skills is 60+.",
    input.avgSkillScore >= 60, input.avgSkillScore, 60));

  // ── Activity ─────────────────────────────────────────────────────────
  out.push({
    id: "active_recent",
    group: "milestone",
    name: "Active contributor",
    description: "Published a skill within the last 7 days.",
    earned: input.daysSinceLastPublish <= 7,
  });

  return out;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

export function tierProgress(tier: ContributorTier, contributorScore: number): {
  current: ContributorTier;
  next: ContributorTier | null;
  progressToNext: number; // 0..1
  pointsToNext: number;
} {
  const idx = TIER_ORDER.indexOf(tier);
  const next = idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1]! : null;
  if (!next) {
    return { current: tier, next: null, progressToNext: 1, pointsToNext: 0 };
  }
  const currentThreshold = TIER_THRESHOLD[tier];
  const nextThreshold = TIER_THRESHOLD[next];
  const span = nextThreshold - currentThreshold;
  const into = contributorScore - currentThreshold;
  const progressToNext = span > 0 ? Math.max(0, Math.min(into / span, 1)) : 0;
  const pointsToNext = Math.max(0, nextThreshold - contributorScore);
  return { current: tier, next, progressToNext, pointsToNext };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function milestone(
  id: string,
  group: Badge["group"],
  name: string,
  description: string,
  earned: boolean,
  current: number,
  target: number,
): Badge {
  return {
    id,
    group,
    name,
    description,
    earned,
    progress: earned ? 1 : Math.min(current / target, 1),
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
