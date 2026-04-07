import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { skillVersions, skills } from "@/db/schema";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const rows = await db
    .select({ displayName: skills.displayName, shortDesc: skills.shortDesc })
    .from(skills)
    .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
    .limit(1);
  const s = rows[0];
  if (!s) return { title: "Skill not found" };
  return {
    title: `${s.displayName} — Agent Skill Depot`,
    description: s.shortDesc,
  };
}

export default async function SkillPage({ params }: PageProps) {
  const { slug } = await params;

  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
    .limit(1);
  const skill = rows[0];
  if (!skill) notFound();

  const versions = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.publishedAt));

  const latest = versions.find((v) => !v.yankedAt);

  return (
    <>
      <section className="hero">
        <div className="muted" style={{ fontFamily: "monospace", fontSize: 13 }}>
          {skill.slug}
          {skill.category && <> · {skill.category}</>}
        </div>
        <h1>{skill.displayName}</h1>
        <p className="lead">{skill.shortDesc}</p>

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">Reputation</div>
            <div className="stat-value">
              {Number(skill.reputationScore).toFixed(1)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Installs</div>
            <div className="stat-value">
              {Number(skill.installCount).toLocaleString()}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Downloads</div>
            <div className="stat-value">
              {Number(skill.downloadCount).toLocaleString()}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Latest</div>
            <div className="stat-value" style={{ fontSize: 20 }}>
              {latest?.semver ?? "—"}
            </div>
          </div>
        </div>

        <p>
          <span className="muted">Install from your Claude session:</span>
          <br />
          <code>install {skill.slug} from agent skill depot</code>
        </p>
      </section>

      {skill.longDescMd && (
        <section>
          <h2>About</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", border: "none", background: "transparent", padding: 0 }}>
            {skill.longDescMd}
          </pre>
        </section>
      )}

      <section>
        <h2>Versions</h2>
        <table className="skills-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>{v.semver}</td>
                <td>{v.publishedAt.toISOString().slice(0, 10)}</td>
                <td>{Math.ceil(v.sizeBytes / 1024)} KB</td>
                <td>
                  {v.yankedAt ? (
                    <span style={{ color: "var(--danger)" }}>yanked</span>
                  ) : v.deprecatedAt ? (
                    <span style={{ color: "var(--warn)" }}>deprecated</span>
                  ) : (
                    <span style={{ color: "var(--success)" }}>live</span>
                  )}
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No published versions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
