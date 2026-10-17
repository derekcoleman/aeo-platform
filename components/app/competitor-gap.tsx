import { ContentRequestForm } from "@/components/app/strategy-forms";
import { when } from "@/components/app/status";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dataForSeoConfigured } from "@/lib/serp/env";
import { gapMarketSupported, listCompetitorGap, marketOf } from "@/lib/strategy/competitor-gap";
import type { TopicRow } from "@/lib/strategy/topics";

/**
 * "Keywords they rank for that you don't" on Strategy → Competitors: where a
 * named competitor ranks in Google's organic top 10 and the site does not,
 * from DataForSEO Labs, refreshed monthly (lib/strategy/competitor-gap.ts).
 * Organic rankings, not AI answers: shown on their own and never added to
 * the AI Overview numbers on the page. Streams in like the other competitor
 * cards. A competitor whose last fetch failed keeps its earlier rankings for
 * a month, marked with their date.
 */

interface Props {
  siteId: string;
  /** The site's locale: the market its keywords are read in. */
  locale: string;
  topicId: string | null;
  topics: Pick<TopicRow, "id" | "name" | "formats">[];
  editor?: boolean;
}

const num = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

export async function CompetitorKeywordGap({ siteId, locale, topicId, topics, editor = false }: Props) {
  const rows = await listCompetitorGap(siteId, { topicId, limit: 50 });
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {!dataForSeoConfigured()
          ? "Keyword rankings come from DataForSEO Labs, and DataForSEO is not configured (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD)."
          : !gapMarketSupported(marketOf(locale))
            ? `The keyword gap reads keywords in the Latin alphabet only, and this site's market is ${locale}: its keywords cannot be matched, so the gap is not fetched.`
            : "No keyword gap yet. Name your competitors with their domains; the gap is found on the 2nd of each month, or now with the button above."}
      </p>
    );
  }
  const fetchedAt = rows.reduce<Date | null>((latest, r) => {
    const d = new Date(r.fetched_at);
    return !latest || d > latest ? d : latest;
  }, null);
  const earlier = (fetched: string) => fetchedAt !== null && new Date(fetched) < fetchedAt;
  const anyEarlier = rows.some((r) => r.competitors.some((c) => earlier(c.fetched_at)));
  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground text-xs">
        Google organic rankings ({rows[0]!.locale}) from DataForSEO Labs, fetched {when(fetchedAt)}. Buyer-intent keywords first, then by monthly searches.
        {anyEarlier ? " A competitor whose last fetch failed shows its earlier rankings, marked with their date." : ""}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Keyword</TableHead>
            <TableHead className="text-right">Searches/mo</TableHead>
            <TableHead className="text-right">Difficulty</TableHead>
            <TableHead>They rank</TableHead>
            <TableHead>You</TableHead>
            {editor ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.keyword}>
              <TableCell className="max-w-xs whitespace-normal">
                <p className="font-medium">{r.keyword}</p>
                <p className="text-muted-foreground text-xs">{r.search_intent ?? "intent unknown"}{r.opportunity_status ? ` · ${r.opportunity_status} on the queue` : ""}</p>
              </TableCell>
              <TableCell className="text-right tabular-nums">{num(r.search_volume)}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.keyword_difficulty)}</TableCell>
              <TableCell className="text-xs">
                {r.competitors.map((c) => (
                  <p key={c.domain}>
                    {c.url ? <a className="underline-offset-2 hover:underline" href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name} <span className="text-muted-foreground tabular-nums">#{c.rank}</span>
                    {earlier(c.fetched_at) ? <span className="text-muted-foreground"> · as of {when(c.fetched_at)}</span> : null}
                  </p>
                ))}
              </TableCell>
              <TableCell className="text-xs">
                {r.brand_rank ? (
                  <span>
                    <Badge variant="warning">#{r.brand_rank}, striking distance</Badge>
                    {r.brand_url ? <a className="text-muted-foreground block truncate underline-offset-2 hover:underline" href={r.brand_url} target="_blank" rel="noreferrer">improve this page</a> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">not in the top 20</span>
                )}
              </TableCell>
              {editor ? (
                <TableCell className="text-right">
                  <ContentRequestForm siteId={siteId} topics={topics} defaultTitle={r.keyword} questionId={r.question_id ?? undefined} compact />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function CompetitorGapLoading() {
  return <p className="text-muted-foreground text-sm">Reading the keyword gap…</p>;
}
