import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { when } from "@/components/app/status";
import { LOW_N, type Proportion } from "@/lib/answers/stats";
import { ANSWER_PROBES_FEATURE, answerProbesConfigured } from "@/lib/answers/sample";
import { engineVisibility } from "@/lib/app/visibility";
import { isFeatureEnabled } from "@/lib/connectors/store";

/**
 * The Engines card on Strategy → Visibility: our own API-grounded probes,
 * per engine, each share with its interval. Its own card, above Profound's
 * and apart from the AI Overview numbers; nothing here is added to either.
 * Streams in after the page, like the competitor cards.
 */

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Share({ p }: { p: Proportion }) {
  if (p.p === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span title={`${p.k} of ${p.n}; 95% interval ${pct(p.low)}–${pct(p.high)}`}>
      {pct(p.p)} <span className="text-muted-foreground text-xs">{pct(p.low)}–{pct(p.high)}</span>
    </span>
  );
}

export async function AnswerEngines({ siteId, orgId, topicId }: { siteId: string; orgId: string; topicId: string | null }) {
  const [report, enabled] = await Promise.all([engineVisibility(siteId, { topicId }), isFeatureEnabled(orgId, ANSWER_PROBES_FEATURE)]);
  if (report.engines.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {!enabled
          ? "Answer probes are off for this organisation. Staff turn them on per organisation; once on, your tracked prompts are asked of each engine every Tuesday, within the AI answer probe budget."
          : !answerProbesConfigured()
            ? "Answer probes are on, but no OpenRouter key is configured, so nothing is sampled."
            : `No probes in the last ${report.days} days yet. Your tracked prompts are asked of each engine every Tuesday at 10:00 UTC.`}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Engine</TableHead>
            <TableHead className="text-right">Answers</TableHead>
            <TableHead className="text-right">Mentioned</TableHead>
            <TableHead className="text-right">Recommended</TableHead>
            <TableHead className="text-right">Cite you</TableHead>
            <TableHead>Most recommended rival</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.engines.map((e) => {
            const rival = e.competitors.find((c) => c.recommendation.k > 0);
            return (
              <TableRow key={e.engine}>
                <TableCell className="max-w-xs whitespace-normal">
                  <p className="font-medium">{e.label}</p>
                  <p className="text-muted-foreground font-mono text-xs">{e.modelVersions.join(", ") || e.engine} · {when(e.lastObservedAt)}</p>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {e.n} {e.lowN ? <Badge variant="warning" title={`Fewer than ${LOW_N} answers: read each share as its range.`}>low n</Badge> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums"><Share p={e.mention} /></TableCell>
                <TableCell className="text-right tabular-nums"><Share p={e.recommendation} /></TableCell>
                <TableCell className="text-right tabular-nums whitespace-normal">
                  {e.nObservable === 0 ? (
                    <span className="text-muted-foreground text-xs">citations not observable via API for this engine</span>
                  ) : (
                    <>
                      <Share p={e.citation} />
                      {e.nObservable < e.n ? <p className="text-muted-foreground text-xs">of {e.nObservable} with sources</p> : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-xs">{rival ? <>{rival.name} <span className="text-muted-foreground">{pct(rival.recommendation.p)}</span></> : <span className="text-muted-foreground">—</span>}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-muted-foreground text-xs">
        {report.label}: each engine&apos;s model asked your tracked prompts through its API with web search on, which is not what its consumer app shows a signed-in buyer. Last {report.days} days, one answer per prompt, engine and day; shares are of answers, with 95% intervals. &ldquo;Cite you&rdquo; counts only answers whose sources the engine exposed. Methodology {report.methodologyVersion}.
      </p>
    </div>
  );
}

export function AnswerEnginesLoading() {
  return <p className="text-muted-foreground text-sm">Reading the last four weeks of answers…</p>;
}
