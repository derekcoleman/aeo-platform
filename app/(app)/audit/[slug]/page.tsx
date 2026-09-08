import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DIMENSION_WEIGHTS, scoreColor, scoreRating, type AuditResult, type Priority } from "@/lib/audit";
import { getPublicAudit } from "@/lib/audit/store";
import { appDatabaseUrl } from "@/lib/db/env";
import { cn } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Score colour → text and bar classes. Theme tokens where they exist; Tailwind palette for the mid bands. */
const TONE: Record<string, { text: string; bar: string; badge: "success" | "warning" | "destructive" | "secondary" }> = {
  emerald: { text: "text-success", bar: "bg-success", badge: "success" },
  green: { text: "text-success", bar: "bg-success", badge: "success" },
  yellow: { text: "text-warning", bar: "bg-warning", badge: "warning" },
  orange: { text: "text-orange-600", bar: "bg-orange-500", badge: "warning" },
  red: { text: "text-destructive", bar: "bg-destructive", badge: "destructive" },
};
const tone = (score: number) => TONE[scoreColor(score)] ?? TONE.red!;

const DIMENSION_LABELS: Record<keyof AuditResult["dimensions"], { label: string; hint: string }> = {
  crawlerAccess: { label: "AI crawler access", hint: "robots.txt verdicts for the crawlers that matter" },
  schema: { label: "Structured data", hint: "JSON-LD and microdata that names what a page is" },
  citability: { label: "Passage citability", hint: "can a passage be lifted verbatim into an answer" },
  eeat: { label: "E-E-A-T signals", hint: "authors, dates, citations, proof" },
  technical: { label: "Technical foundation", hint: "rendering, meta tags, headers, mobile" },
  llmsTxt: { label: "llms.txt", hint: "the file that tells models what to read first" },
};

const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "low"];
const PRIORITY_BADGE: Record<Priority, "destructive" | "warning" | "secondary" | "outline"> = { critical: "destructive", high: "warning", medium: "secondary", low: "outline" };

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const found = appDatabaseUrl() ? await getPublicAudit(slug).catch(() => null) : null;
  if (!found || found.run.status !== "completed") return { title: "AEO audit", robots: { index: false } };
  return {
    title: `${found.run.domain} scores ${found.run.geo_score}/100 for AI answers`,
    description: `AI-readiness audit of ${found.run.domain}: crawler access, schema, citability, E-E-A-T and llms.txt.`,
    robots: { index: false },
  };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 pb-16">
      <header className="flex items-center justify-between py-6">
        <Link href="/" className="font-semibold tracking-tight">AEO Platform</Link>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost"><Link href="/audit">Scan another site</Link></Button>
          <Button asChild variant="outline"><Link href={"/login" as Route}>Sign in</Link></Button>
        </nav>
      </header>
      {children}
    </main>
  );
}

export default async function AuditReportPage({ params }: Params) {
  const { slug } = await params;
  if (!appDatabaseUrl()) {
    return (
      <Shell>
        <Alert variant="warning"><AlertTitle>Audits are not set up on this deployment yet</AlertTitle><AlertDescription>The app has no database connection. Set DATABASE_URL and redeploy.</AlertDescription></Alert>
      </Shell>
    );
  }
  const found = await getPublicAudit(slug);
  if (!found) notFound();
  const { run } = found;

  if (run.status !== "completed" || !run.result) {
    return (
      <Shell>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="text-xl">{run.domain}</CardTitle>
            <CardDescription>{run.status === "failed" ? "This audit failed." : "This audit is still running. Refresh in a minute."}</CardDescription>
          </CardHeader>
          {run.status === "failed" ? (
            <CardContent className="grid gap-4">
              <Alert variant="destructive"><AlertTitle>What went wrong</AlertTitle><AlertDescription>{run.error ?? "unknown error"}</AlertDescription></Alert>
              <Button asChild className="w-fit"><Link href="/audit">Try again <ArrowRight /></Link></Button>
            </CardContent>
          ) : null}
        </Card>
      </Shell>
    );
  }

  const r = run.result;
  const score = r.geoScore;
  const recs = [...r.recommendations].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const degradedModules = new Set(r.degraded.map((d) => d.module));
  const tier1 = r.crawlerAccess?.crawlers.filter((c) => c.tier === 1) ?? [];
  const pages = r.citability ? [...r.citability.pages].sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || a.averageScore - b.averageScore) : [];

  return (
    <Shell>
      <section className="grid gap-6 py-6 md:grid-cols-[auto_1fr] md:items-center">
        <div className={cn("flex size-36 flex-col items-center justify-center rounded-full border-8", tone(score).text)} style={{ borderColor: "currentColor" }}>
          <span className="text-5xl font-semibold leading-none">{score}</span>
          <span className="text-muted-foreground mt-1 text-xs">out of 100</span>
        </div>
        <div className="grid gap-2">
          <p className="text-muted-foreground text-sm font-medium">AI-readiness audit</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{r.domain}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tone(score).badge} className="capitalize">{scoreRating(score)}</Badge>
            <span className="text-muted-foreground text-sm">{r.pagesAnalyzed} pages analysed in {(r.durationMs / 1000).toFixed(0)}s · rules {r.ruleRegistryVersion}</span>
          </div>
        </div>
      </section>

      {r.degraded.length > 0 ? (
        <Alert variant="warning" className="mb-6">
          <AlertTitle>Partial result</AlertTitle>
          <AlertDescription>
            <p>Some checks could not run. They are excluded from the score rather than counted as zero.</p>
            <ul className="list-disc pl-4">
              {r.degraded.map((d) => <li key={d.module}><span className="font-mono text-xs">{d.module}</span>: {d.reason}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Score breakdown</CardTitle><CardDescription>Six weighted dimensions. Platform readiness is shown below but does not count.</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            {(Object.keys(DIMENSION_LABELS) as (keyof AuditResult["dimensions"])[]).map((key) => {
              const v = r.dimensions[key];
              const off = degradedModules.has(key);
              return (
                <div key={key} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{DIMENSION_LABELS[key].label} <span className="text-muted-foreground font-normal">· {Math.round(DIMENSION_WEIGHTS[key] * 100)}%</span></p>
                      <p className="text-muted-foreground text-xs">{DIMENSION_LABELS[key].hint}</p>
                    </div>
                    <span className={cn("text-lg font-semibold tabular-nums", off ? "text-muted-foreground" : tone(v).text)}>{off ? "n/a" : v}</span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full"><div className={cn("h-full rounded-full", off ? "bg-muted" : tone(v).bar)} style={{ width: `${off ? 0 : Math.max(2, Math.min(100, v))}%` }} /></div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI crawler access</CardTitle>
            <CardDescription>
              {r.crawlerAccess ? (
                <>robots.txt {r.crawlerAccess.robotsTxtFound ? "found" : "not found"}{r.crawlerAccess.blanketBlockDetected ? " · blanket block on all crawlers" : ""}{r.crawlerAccess.aiSpecificFilesPresent ? " · llms.txt / ai.txt present" : ""}</>
              ) : "This check could not run."}
            </CardDescription>
          </CardHeader>
          {r.crawlerAccess ? (
            <CardContent className="grid gap-4">
              <ul className="grid gap-2">
                {tier1.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      {c.allowed ? <Check className="text-success size-4" /> : <X className="text-destructive size-4" />}
                      <span className="font-medium">{c.name}</span>
                    </span>
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">{c.rule ? <code className="bg-muted rounded px-1.5 py-0.5">{c.rule}</code> : null}{c.allowed ? "allowed" : "blocked"}</span>
                  </li>
                ))}
              </ul>
              {r.crawlerAccess.pathBlocks.length > 0 ? (
                <p className="text-sm">
                  <span className="font-medium">Paths blocked for AI crawlers while open to everyone else: </span>
                  {r.crawlerAccess.pathBlocks.map((p) => <code key={p.path} className="bg-muted mr-1.5 rounded px-1.5 py-0.5 text-xs">{p.path}</code>)}
                </p>
              ) : null}
            </CardContent>
          ) : null}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>What to fix first</CardTitle><CardDescription>Every finding comes from a named rule, ordered by how much it holds the score back.</CardDescription></CardHeader>
        <CardContent>
          {recs.length === 0 ? <p className="text-muted-foreground text-sm">No recommendations. Every rule passed.</p> : (
            <ol className="grid gap-4">
              {recs.map((rec, i) => (
                <li key={rec.ruleKey} className="grid grid-cols-[2rem_1fr] gap-3">
                  <span className="text-muted-foreground pt-0.5 text-sm tabular-nums">{i + 1}.</span>
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{rec.title}</span>
                      <Badge variant={PRIORITY_BADGE[rec.priority]} className="capitalize">{rec.priority}</Badge>
                      <Badge variant="outline">{rec.category.replace(/_/g, " ")}</Badge>
                    </div>
                    <p className="text-sm">{rec.description}</p>
                    <p className="text-muted-foreground text-sm">Impact: {rec.impact}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {r.citability ? (
        <Card className="mt-6">
          <CardHeader><CardTitle>Per-page citability</CardTitle><CardDescription>Lowest first. These are the pages to restructure before writing anything new.</CardDescription></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Page</TableHead><TableHead className="text-right">Score</TableHead></TableRow></TableHeader>
              <TableBody>
                {pages.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="max-w-xl">
                      <a href={p.url} rel="nofollow noopener noreferrer" target="_blank" className="font-medium underline-offset-2 hover:underline">{p.title || p.url}</a>
                      <p className="text-muted-foreground truncate font-mono text-xs">{p.url}</p>
                    </TableCell>
                    <TableCell className={cn("text-right font-semibold tabular-nums", p.error ? "text-muted-foreground" : tone(p.averageScore).text)}>{p.error ? "n/a" : p.averageScore}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {r.platformReadiness ? (
        <Card className="mt-6">
          <CardHeader><CardTitle>Platform readiness</CardTitle><CardDescription>Model-assessed and shown for orientation only. It does not contribute to the score.</CardDescription></CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2">
              {Object.entries(r.platformReadiness.platforms).map(([name, p]) => (
                <li key={name} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between"><span className="font-medium">{name}</span><span className={cn("font-semibold tabular-nums", tone(p.score).text)}>{p.score}</span></div>
                  {p.weaknesses[0] ? <p className="text-muted-foreground mt-1 text-sm">{p.weaknesses[0]}</p> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">Share link expires {new Date(found.share.expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.</p>
        <Button asChild><Link href={"/login" as Route}>Fix these with a project <ArrowRight /></Link></Button>
      </div>
    </Shell>
  );
}
