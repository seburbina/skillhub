/**
 * Ranking library — pure functions that turn telemetry into reputation.
 *
 * Two formulas:
 *   1. `reputation_score` — per-skill, 0..100. Combines iter_signal,
 *      rating_signal, adoption_signal, speed_signal, recency_signal.
 *      Weighted toward "fewer follow-up iterations" because that's the
 *      strongest signal a skill actually offloaded work.
 *   2. `contributor_score` — per-user, unbounded. Rewards shipping more,
 *      better skills and staying active; decays to 0 over 45 days of
 *      inactivity. Drives the public leaderboard + tier badges.
 *
 * Both formulas take a `weights` argument loaded from the config tables
 * (`ranking_weights` and `contributor_score_weights`) so they can be tuned
 * without redeploy.
 *
 * This file is PURE — no DB, no I/O. That makes it cheap to unit-test with
 * fixture data, which is critical because tweaks to the formula can silently
 * reshape the leaderboard.
 */

// ---------------------------------------------------------------------------
// Weight types (mirror the DB config tables)
// ---------------------------------------------------------------------------

export interface RankingWeights {
  iter: number;
  rating: number;
  adoption: number;
  speed: number;
  recency: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  iter: 0.4,
  rating: 0.25,
  adoption: 0.2,
  speed: 0.1,
  recency: 0.05,
};

export interface ContributorScoreWeights {
  effort: number;
  adoption: number;
  reach: number;
  quality: number;
  consistency: number;
  recency: number;
  recencyDecayDays: number;
}

export const DEFAULT_CONTRIBUTOR_WEIGHTS: ContributorScoreWeights = {
  effort: 8,
  adoption: 4,
  reach: 2,
  quality: 6,
  consistency: 5,
  recency: 3,
  recencyDecayDays: 45,
};

// ---------------------------------------------------------------------------
// Skill reputation_score
// ---------------------------------------------------------------------------

export interface SkillStats {
  medianFollowUpIterations: number;
  upRatings: number;
  downRatings: number;
  installCount: number;
  medianDurationMs: number;
  daysSinceLastUse: number;
}

export interface SkillScoreBreakdown {
  iterSignal: number;
  ratingSignal: number;
  adoptionSignal: number;
  speedSignal: number;
  recencySignal: number;
  rawScore: number;
  reputationScore: number; // 0..100
}

/**
 * Compute reputation_score from a snapshot of skill stats.
 * Returns both the final score and the per-signal breakdown for dashboards.
 */
export function computeSkillScore(
  stats: SkillStats,
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
): SkillScoreBreakdown {
  const iterSignal = clamp(1 - stats.medianFollowUpIterations / 8, 0, 1);

  // Laplace-smoothed up/down ratio; neutral prior when there are no ratings.
  const ratingSignal =
    (stats.upRatings + 1) / (stats.upRatings + stats.downRatings + 2);

  // log10(installs+1) normalized to reach 1.0 at ~10k installs.
  const adoptionSignal = Math.min(
    Math.log10(stats.installCount + 1) / Math.log10(10001),
    1,
  );

  const speedSignal = clamp(1 - stats.medianDurationMs / 30000, 0, 1);

  // 30-day half-life exponential decay
  const recencySignal = Math.exp(-stats.daysSinceLastUse / 30);

  const rawScore =
    weights.iter * iterSignal +
    weights.rating * ratingSignal +
    weights.adoption * adoptionSignal +
    weights.speed * speedSignal +
    weights.recency * recencySignal;

  const reputationScore = round4(rawScore * 100);

  return {
    iterSignal: round4(iterSignal),
    ratingSignal: round4(ratingSignal),
    adoptionSignal: round4(adoptionSignal),
    speedSignal: round4(speedSignal),
    recencySignal: round4(recencySignal),
    rawScore: round4(rawScore),
    reputationScore,
  };
}

// ---------------------------------------------------------------------------
// User contributor_score + tier
// ---------------------------------------------------------------------------

export type ContributorTier =
  | "unranked"
  | "bronze"
  | "silver"
  | "gold"
  | "platinum";

export interface UserStatsInput {
  skillsPublished: number;
  totalInstalls: number;
  totalDownloads: number;
  bestSkillScore: number; // 0..100
  avgSkillScore: number; // 0..100
  daysSinceLastPublish: number;
}

export interface ContributorScoreBreakdown {
  effort: number;
  adoption: number;
  reach: number;
  quality: number;
  consistency: number;
  recency: number;
  contributorScore: number; // unbounded
  tier: ContributorTier;
}

/**
 * Compute `contributor_score` and tier from a snapshot of user stats.
 *
 * Published skills matter (effort), but quality signals (best_skill_score,
 * avg_skill_score) balance it so publishing lots of bad skills doesn't climb
 * the board. Recency decays to 0 after `recencyDecayDays` of inactivity.
 */
export function computeContributorScore(
  stats: UserStatsInput,
  weights: ContributorScoreWeights = DEFAULT_CONTRIBUTOR_WEIGHTS,
): ContributorScoreBreakdown {
  const effort = weights.effort * Math.log10(stats.skillsPublished + 1);
  const adoption = weights.adoption * Math.log10(stats.totalInstalls + 1);
  const reach = weights.reach * Math.log10(stats.totalDownloads + 1);
  const quality = weights.quality * (stats.bestSkillScore / 100);
  const consistency = weights.consistency * (stats.avgSkillScore / 100);

  const recencyMultiplier = clamp(
    1 - stats.daysSinceLastPublish / weights.recencyDecayDays,
    0,
    1,
  );
  const recency = weights.recency * recencyMultiplier;

  const contributorScore = round4(
    effort + adoption + reach + quality + consistency + recency,
  );
  const tier = computeTier(contributorScore);

  return {
    effort: round4(effort),
    adoption: round4(adoption),
    reach: round4(reach),
    quality: round4(quality),
    consistency: round4(consistency),
    recency: round4(recency),
    contributorScore,
    tier,
  };
}

export function computeTier(contributorScore: number): ContributorTier {
  if (contributorScore >= 35) return "platinum";
  if (contributorScore >= 20) return "gold";
  if (contributorScore >= 10) return "silver";
  if (contributorScore >= 1) return "bronze";
  return "unranked";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
