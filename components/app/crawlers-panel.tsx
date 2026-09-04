import type { CrawlSummary } from "@/lib/analytics/crawl";
import type { ProxyMode } from "@/lib/tenancy/types";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PURPOSE_LABEL: Record<string, { title: string; blurb: string }> = {
  live_fetch: { title: "Live fetches", blurb: "A model fetched a page mid-answer, for a real person. The closest thing to a real-time citation signal." },
  search_index: { title: "Search indexing", blurb: "AI search indexes (OAI-SearchBot, PerplexityBot, Bingbot). Weeks to matter." },
  train: { title: "Training crawls", blurb: "GPTBot, ClaudeBot, CCBot, Google-Extended. Months to matter." },
  other: { title: "Other", blurb: "Recognised bots without a purpose classification." },
};

function count(s: CrawlSummary, purpose: string, key: "hits24h" | "hits7d" | "verified7d"): number {
  return s.byPurpose.find((p) => p.purpose === purpose)?.[key] ?? 0;
}

/** Server component. Everything here reads from crawl_events / crawl_daily; nothing is estimated. */
export function CrawlersPanel({ crawl, proxyMode }: { crawl: CrawlSummary; proxyMode: ProxyMode }) {
  const coverageNote =
    crawl.coverage === "full"
      ? { variant: "success" as const, title: "Complete coverage", body: "Your Worker reports every crawler hit, including ones served from cache." }
      : crawl.coverage === "partial"
        ? { variant: "warning" as const, title: "Partial coverage", body: `Only requests that reach our origin are counted. ${proxyMode === "cloudflare_worker" ? "Your Worker is not posting telemetry yet — check its crawlEndpoint and secret." : "Cache hits at your edge are invisible to us; the Cloudflare Worker install mode fixes that."}` }
        : { variant: "default" as const, title: "No crawler traffic recorded yet", body: "Hits appear here within a minute of an AI crawler fetching one of your published pages." };
  return (
    <>
      <Alert variant={coverageNote.variant}>
        <AlertTitle>{coverageNote.title}</AlertTitle>
        <AlertDescription>{coverageNote.body}</AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-3">
        {(["live_fetch", "search_index", "train"] as const).map((purpose) => {
          const meta = PURPOSE_LABEL[purpose]!;
          const h24 = count(crawl, purpose, "hits24h");
          const h7 = count(crawl, purpose, "hits7d");
          const v7 = count(crawl, purpose, "verified7d");
          return (
            <Card key={purpose}>
              <CardHeader className="pb-2"><CardDescription>{meta.title}</CardDescription><CardTitle className="text-3xl tabular-nums">{h24}</CardTitle></CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                <p>last 24h · {h7} in 7d · {h7 ? Math.round((v7 / h7) * 100) : 0}% IP-verified</p>
                <p className="mt-2">{meta.blurb}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card>
        <CardHeader><CardTitle>Pages models fetched mid-answer</CardTitle><CardDescription>Last 7 days. Each fetch is a model reading this page to answer someone right now.</CardDescription></CardHeader>
        <CardContent>
          {crawl.liveFetchPaths.length === 0 ? <p className="text-muted-foreground text-sm">No live fetches yet.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Page</TableHead><TableHead className="text-right">Fetches</TableHead><TableHead>Last</TableHead></TableRow></TableHeader>
              <TableBody>
                {crawl.liveFetchPaths.map((p) => (
                  <TableRow key={p.path}>
                    <TableCell><div className="font-medium">{p.title ?? p.path}</div>{p.title ? <div className="text-muted-foreground font-mono text-xs">{p.path}</div> : null}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.hits}</TableCell>
                    <TableCell>{when(p.last_seen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>By crawler</CardTitle><CardDescription>Last 30 days. Verified means the source address was inside the operator&apos;s published ranges.</CardDescription></CardHeader>
          <CardContent>
            {crawl.byFamily.length === 0 ? <p className="text-muted-foreground text-sm">Nothing yet.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Bot</TableHead><TableHead>Purpose</TableHead><TableHead className="text-right">Hits</TableHead><TableHead className="text-right">Verified</TableHead><TableHead>Last</TableHead></TableRow></TableHeader>
                <TableBody>
                  {crawl.byFamily.map((f) => (
                    <TableRow key={f.bot_family}>
                      <TableCell className="font-mono text-xs">{f.bot_family}</TableCell>
                      <TableCell><Badge variant={f.purpose === "live_fetch" ? "success" : "secondary"}>{f.purpose}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums">{f.hits}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.verified_hits}</TableCell>
                      <TableCell>{when(f.last_seen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent live fetches</CardTitle><CardDescription>The last 20, newest first.</CardDescription></CardHeader>
          <CardContent>
            {crawl.recentLive.length === 0 ? <p className="text-muted-foreground text-sm">Nothing yet.</p> : (
              <ul className="grid gap-1 text-sm">
                {crawl.recentLive.map((e, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{e.path}</span>
                    <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
                      {e.bot_family}{e.verified ? <Badge variant="success">verified</Badge> : <Badge variant="outline">unverified</Badge>}{e.cache_status ? <span>{e.cache_status}</span> : null}<span>{when(e.ts)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
