import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { competitorDomains, type CompetitorDomainRow } from "@/lib/app/strategy";

/**
 * Who gets cited instead of us, streamed in after the rest of the Strategy
 * page: the count walks every citation of the last 30 days (hundreds of
 * thousands on a site with a Profound backfill), and the page must not wait
 * on it before showing anything. Google AI Overview citations from our own
 * trackers come first; Profound's, from other engines, are a separate list
 * and never added to them.
 */
export async function CompetitorDomains({ siteId, topicId, profound = false }: { siteId: string; topicId: string | null; profound?: boolean }) {
  const [native, viaProfound] = await Promise.all([
    competitorDomains(siteId, { topicId }),
    profound ? competitorDomains(siteId, { topicId, providers: ["profound"] }) : Promise.resolve([] as CompetitorDomainRow[]),
  ]);
  return (
    <>
      {native.length === 0 ? <p className="text-muted-foreground text-sm">No AI Overview competitor citations recorded yet.</p> : <DomainTable rows={native} sourceLabel="Tracker" />}
      {viaProfound.length ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">Profound (ChatGPT, Perplexity, Gemini, Copilot, AI Mode): Profound&apos;s data, not AI Overview citations.</p>
          <DomainTable rows={viaProfound} sourceLabel="Source" />
        </div>
      ) : null}
    </>
  );
}

function DomainTable({ rows, sourceLabel }: { rows: CompetitorDomainRow[]; sourceLabel: string }) {
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Domain</TableHead><TableHead className="text-right">Citations</TableHead><TableHead className="text-right">Prompts</TableHead><TableHead>{sourceLabel}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((d) => <TableRow key={d.domain}><TableCell className="font-medium">{d.domain}</TableCell><TableCell className="text-right tabular-nums">{d.citations}</TableCell><TableCell className="text-right tabular-nums">{d.questions}</TableCell><TableCell className="text-xs">{d.providers.join(", ")}</TableCell></TableRow>)}</TableBody>
    </Table>
  );
}

export function CompetitorDomainsLoading() {
  return <p className="text-muted-foreground text-sm">Counting citations from the last 30 days…</p>;
}
