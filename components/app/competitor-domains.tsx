import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { competitorDomains } from "@/lib/app/strategy";

/**
 * Who gets cited instead of us, streamed in after the rest of the Strategy
 * page: the count walks every citation of the last 30 days (hundreds of
 * thousands on a site with a Profound backfill), and the page must not wait
 * on it before showing anything.
 */
export async function CompetitorDomains({ siteId, topicId }: { siteId: string; topicId: string | null }) {
  const domains = await competitorDomains(siteId, { topicId });
  if (domains.length === 0) return <p className="text-muted-foreground text-sm">No competitor citations recorded yet.</p>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Domain</TableHead><TableHead className="text-right">Citations</TableHead><TableHead className="text-right">Prompts</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
      <TableBody>{domains.map((d) => <TableRow key={d.domain}><TableCell className="font-medium">{d.domain}</TableCell><TableCell className="text-right tabular-nums">{d.citations}</TableCell><TableCell className="text-right tabular-nums">{d.questions}</TableCell><TableCell className="text-xs">{d.providers.join(", ")}</TableCell></TableRow>)}</TableBody>
    </Table>
  );
}

export function CompetitorDomainsLoading() {
  return <p className="text-muted-foreground text-sm">Counting citations from the last 30 days…</p>;
}
