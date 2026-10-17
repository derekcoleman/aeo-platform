import { ActionButton } from "@/components/app/action-button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EditCompetitor, MarkCompetitor, SourceRoleForm } from "@/components/app/strategy-forms";
import { namedCompetitors, sourcesShapingAnswers, type NamedCompetitorRow, type SourceRoleGroup } from "@/lib/app/strategy";
import { removeCompetitorAction } from "@/lib/app/strategy-actions";
import { OVERRIDE_SOURCE_ROLES, SOURCE_ROLE_LABELS } from "@/lib/measure/source-roles";

/**
 * Who gets cited instead of us, split by what the cited site is. Both cards
 * stream in after the rest of the Strategy page: the counts walk every
 * citation of the last 30 days (hundreds of thousands on a site with a
 * Profound backfill), and the page must not wait on them before showing
 * anything. Google AI Overview citations from our own trackers come first;
 * Profound's, from other engines, are a separate column or list and never
 * added to them.
 */

interface Props {
  siteId: string;
  topicId: string | null;
  profound?: boolean;
  editor?: boolean;
}

/** The named competitors (the org's competitor entities), each with its native and Profound citation counts. */
export async function NamedCompetitors({ siteId, topicId, profound = false, editor = false }: Props) {
  const [native, viaProfound] = await Promise.all([
    namedCompetitors(siteId, { topicId }),
    profound ? namedCompetitors(siteId, { topicId, providers: ["profound"] }) : Promise.resolve([] as NamedCompetitorRow[]),
  ]);
  if (native.length === 0) {
    return <p className="text-muted-foreground text-sm">No competitors named yet. Add the rivals buyers compare you with, or mark one from the sources below; their domains count as them from then on, citations already recorded included.</p>;
  }
  const profoundCount = new Map(viaProfound.map((r) => [r.entity_id, r.citations]));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Competitor</TableHead>
          <TableHead className="text-right">AI Overview citations</TableHead>
          <TableHead className="text-right">Prompts</TableHead>
          {profound ? <TableHead className="text-right">Profound</TableHead> : null}
          {editor ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {native.map((c) => (
          <TableRow key={c.entity_id}>
            <TableCell className="max-w-xs">
              <p className="font-medium">{c.name} {c.unconfirmed ? <Badge variant="outline">from a topic</Badge> : null}</p>
              <p className="text-muted-foreground font-mono text-xs">{c.domains.length ? c.domains.join(", ") : "no domain yet: add one to count its citations"}</p>
              {c.aliases.length ? <p className="text-muted-foreground text-xs">also {c.aliases.join(", ")}</p> : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">{c.citations}</TableCell>
            <TableCell className="text-right tabular-nums">{c.questions}</TableCell>
            {profound ? <TableCell className="text-right tabular-nums">{profoundCount.get(c.entity_id) ?? 0}</TableCell> : null}
            {editor ? (
              <TableCell className="text-right">
                <span className="inline-flex flex-wrap items-center justify-end gap-1">
                  <EditCompetitor siteId={siteId} competitor={{ entity_id: c.entity_id, name: c.name, domains: c.domains, aliases: c.aliases }} confirm={c.unconfirmed} />
                  <ActionButton size="sm" variant="ghost" className="h-7 px-2 text-xs" action={removeCompetitorAction.bind(null, siteId, c.entity_id)} done="Removed">Not a competitor</ActionButton>
                </span>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const ROLE_OPTIONS = OVERRIDE_SOURCE_ROLES.map((r) => ({ value: r, label: SOURCE_ROLE_LABELS[r] }));

/** Every other cited site, grouped by role: forums, review platforms, publishers, reference… the earned-media targets. */
export async function SourcesShapingAnswers({ siteId, topicId, profound = false, editor = false }: Props) {
  const [native, viaProfound] = await Promise.all([
    sourcesShapingAnswers(siteId, { topicId }),
    profound ? sourcesShapingAnswers(siteId, { topicId, providers: ["profound"] }) : Promise.resolve([] as SourceRoleGroup[]),
  ]);
  return (
    <>
      {native.length === 0 ? <p className="text-muted-foreground text-sm">No other sites cited in AI Overviews in the last 30 days.</p> : <RoleGroups groups={native} siteId={siteId} editor={editor} />}
      {viaProfound.length ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">Profound (ChatGPT, Perplexity, Gemini, Copilot, AI Mode): Profound&apos;s data, not AI Overview citations.</p>
          <RoleGroups groups={viaProfound} siteId={siteId} editor={false} />
        </div>
      ) : null}
    </>
  );
}

function RoleGroups({ groups, siteId, editor }: { groups: SourceRoleGroup[]; siteId: string; editor: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Site</TableHead>
          <TableHead className="text-right">Citations</TableHead>
          <TableHead className="text-right">Prompts</TableHead>
          <TableHead>Source</TableHead>
          {editor ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.flatMap((g) => [
          <TableRow key={`role:${g.role}`} className="bg-muted/40 hover:bg-muted/40">
            <TableCell colSpan={editor ? 5 : 4} className="text-xs font-medium">{g.label} <span className="text-muted-foreground tabular-nums">· {g.citations}</span></TableCell>
          </TableRow>,
          ...g.domains.map((d) => (
            <TableRow key={`${g.role}:${d.domain}`}>
              <TableCell className="font-medium">{d.domain}{d.overridden ? <span className="text-muted-foreground text-xs"> · set by you</span> : null}</TableCell>
              <TableCell className="text-right tabular-nums">{d.citations}</TableCell>
              <TableCell className="text-right tabular-nums">{d.questions}</TableCell>
              <TableCell className="text-xs">{d.providers.join(", ")}</TableCell>
              {editor ? (
                <TableCell className="text-right">
                  <span className="inline-flex flex-wrap items-center justify-end gap-1">
                    <SourceRoleForm siteId={siteId} domain={d.domain} role={d.role} overridden={d.overridden} roles={ROLE_OPTIONS} />
                    <MarkCompetitor siteId={siteId} domain={d.domain} />
                  </span>
                </TableCell>
              ) : null}
            </TableRow>
          )),
        ])}
      </TableBody>
    </Table>
  );
}

export function CompetitorDomainsLoading() {
  return <p className="text-muted-foreground text-sm">Counting citations from the last 30 days…</p>;
}
