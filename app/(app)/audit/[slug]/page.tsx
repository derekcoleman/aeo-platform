import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DIMENSION_WEIGHTS, scoreColor, scoreRating, type AuditResult, type Priority } from "@/lib/audit";
import { getPublicAudit } from "@/lib/audit/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLORS: Record<string, string> = {
  emerald: "#047857",
  green: "#15803d",
  yellow: "#a16207",
  orange: "#c2410c",
  red: "#b91c1c",
};

const DIMENSION_LABELS: Record<keyof AuditResult["dimensions"], string> = {
  crawlerAccess: "AI crawler access",
  schema: "Structured data",
  citability: "Passage citability",
  eeat: "E-E-A-T signals",
  technical: "Technical foundation",
  llmsTxt: "llms.txt",
};

const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "low"];

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const found = await getPublicAudit(slug);
  if (!found || found.run.status !== "completed") return { title: "AEO audit" };
  return {
    title: `${found.run.domain} scores ${found.run.geo_score}/100 for AI answers`,
    description: `AI-readiness audit of ${found.run.domain}: crawler access, schema, citability, E-E-A-T and llms.txt.`,
    robots: { index: false },
  };
}

export default async function AuditReportPage({ params }: Params) {
  const { slug } = await params;
  const found = await getPublicAudit(slug);
  if (!found) notFound();
  const { run } = found;

  if (run.status !== "completed" || !run.result) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "3rem", maxWidth: "44rem" }}>
        <h1>{run.domain}</h1>
        <p>{run.status === "failed" ? `This audit failed: ${run.error ?? "unknown error"}.` : "This audit is still running."}</p>
      </main>
    );
  }

  const r = run.result;
  const score = r.geoScore;
  const color = COLORS[scoreColor(score)] ?? "#333";
  const recs = [...r.recommendations].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  );
  const degradedModules = new Set(r.degraded.map((d) => d.module));

  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", maxWidth: "52rem" }}>
      <p style={{ color: "#666" }}>AI-readiness audit</p>
      <h1 style={{ marginBottom: 0 }}>{r.domain}</h1>
      <p style={{ fontSize: "3rem", fontWeight: 700, color, margin: "0.5rem 0 0" }}>
        {score}
        <span style={{ fontSize: "1rem", color: "#666", fontWeight: 400 }}> / 100 · {scoreRating(score)}</span>
      </p>
      <p style={{ color: "#666" }}>
        {r.pagesAnalyzed} pages analysed in {(r.durationMs / 1000).toFixed(0)}s · rules {r.ruleRegistryVersion}
      </p>

      {r.degraded.length > 0 && (
        <section style={{ background: "#fff7ed", border: "1px solid #fdba74", padding: "1rem", borderRadius: 6 }}>
          <strong>Partial result.</strong> Some checks could not run and are excluded from the score rather than
          counted as zero:
          <ul style={{ margin: "0.5rem 0 0" }}>
            {r.degraded.map((d) => (
              <li key={d.module}>
                <code>{d.module}</code> — {d.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Score breakdown</h2>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {(Object.keys(DIMENSION_LABELS) as (keyof AuditResult["dimensions"])[]).map((key) => {
              const v = r.dimensions[key];
              const off = degradedModules.has(key);
              return (
                <tr key={key} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.5rem 0" }}>{DIMENSION_LABELS[key]}</td>
                  <td style={{ color: "#888", fontSize: "0.85rem" }}>weight {Math.round(DIMENSION_WEIGHTS[key] * 100)}%</td>
                  <td style={{ textAlign: "right", fontWeight: 600, color: off ? "#999" : COLORS[scoreColor(v)] }}>
                    {off ? "n/a" : v}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {r.crawlerAccess && (
        <section>
          <h2>AI crawler access</h2>
          <p>
            robots.txt {r.crawlerAccess.robotsTxtFound ? "found" : "not found"}
            {r.crawlerAccess.blanketBlockDetected && " · blanket block on all crawlers"}
            {r.crawlerAccess.aiSpecificFilesPresent && " · llms.txt / ai.txt present"}
          </p>
          <ul>
            {r.crawlerAccess.crawlers.filter((c) => c.tier === 1).map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong>: {c.allowed ? "allowed" : "blocked"}
                {c.rule ? <code style={{ marginLeft: 6 }}>{c.rule}</code> : null}
              </li>
            ))}
          </ul>
          {r.crawlerAccess.pathBlocks.length > 0 && (
            <p>
              Paths blocked for AI crawlers while open to everyone else:{" "}
              {r.crawlerAccess.pathBlocks.map((p) => (
                <code key={p.path} style={{ marginRight: 6 }}>{p.path}</code>
              ))}
            </p>
          )}
        </section>
      )}

      <section>
        <h2>What to fix first</h2>
        {recs.length === 0 ? (
          <p>No recommendations — every rule passed.</p>
        ) : (
          <ol>
            {recs.map((rec) => (
              <li key={rec.ruleKey} style={{ marginBottom: "0.75rem" }}>
                <strong>{rec.title}</strong>{" "}
                <span style={{ fontSize: "0.8rem", color: "#666" }}>[{rec.priority} · {rec.category}]</span>
                <div>{rec.description}</div>
                <div style={{ color: "#666", fontSize: "0.9rem" }}>Impact: {rec.impact}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {r.citability && (
        <section>
          <h2>Per-page citability</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
                <th style={{ padding: "0.4rem 0" }}>Page</th>
                <th style={{ textAlign: "right" }}>Score</th>
              </tr>
            </thead>
            <tbody>
              {[...r.citability.pages]
                .sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || a.averageScore - b.averageScore)
                .map((p) => (
                  <tr key={p.url} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.4rem 0", wordBreak: "break-all" }}>
                      <a href={p.url} rel="nofollow noopener">{p.title || p.url}</a>
                      <div style={{ color: "#888", fontSize: "0.8rem" }}>{p.url}</div>
                    </td>
                    <td style={{ textAlign: "right", color: p.error ? "#999" : COLORS[scoreColor(p.averageScore)] }}>
                      {p.error ? "n/a" : p.averageScore}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {r.platformReadiness && (
        <section>
          <h2>Platform readiness</h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            Model-assessed and shown for orientation only — it does not contribute to the score.
          </p>
          <ul>
            {Object.entries(r.platformReadiness.platforms).map(([name, p]) => (
              <li key={name}>
                <strong>{name}</strong>: {p.score}
                {p.weaknesses[0] ? ` — ${p.weaknesses[0]}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p style={{ color: "#888", fontSize: "0.85rem", marginTop: "3rem" }}>
        Share link expires {new Date(found.share.expires_at).toLocaleDateString("en-US")}.
      </p>
    </main>
  );
}
