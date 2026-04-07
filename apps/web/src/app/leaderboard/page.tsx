import Link from "next/link";
import { desc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leaderboard — Agent Skill Depot" };

export default async function LeaderboardPage() {
  // Top skills by reputation_score
  const topSkills = await db
    .select({
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      category: skills.category,
    })
    .from(skills)
    .where(
      sql`${skills.deletedAt} IS NULL AND ${skills.visibility} IN ('public_free', 'public_paid')`,
    )
    .orderBy(desc(skills.reputationScore))
    .limit(100);

  return (
    <>
      <section className="hero">
        <h1>Leaderboard</h1>
        <p className="lead">
          Top skills on Agent Skill Depot, ranked by reputation score —
          weighted toward fewer follow-up iterations because that&apos;s
          what separates a good skill from a great one.
        </p>
      </section>

      <section>
        <h2>Top skills</h2>
        <table className="skills-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Skill</th>
              <th>Score</th>
              <th>Installs</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody>
            {topSkills.map((s, i) => (
              <tr key={s.slug}>
                <td>#{i + 1}</td>
                <td>
                  <Link href={`/s/${s.slug}`}>
                    <strong>{s.displayName}</strong>
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {s.shortDesc}
                  </div>
                </td>
                <td>
                  <span className="score-badge">
                    {Number(s.reputationScore).toFixed(1)}
                  </span>
                </td>
                <td>{Number(s.installCount).toLocaleString()}</td>
                <td>{Number(s.downloadCount).toLocaleString()}</td>
              </tr>
            ))}
            {topSkills.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No skills published yet. Be the first!
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
