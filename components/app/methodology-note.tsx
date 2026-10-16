import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { METHODOLOGY_CHANGES, METHODOLOGY_VERSION, RESTATED_METRICS, type RestatementRow } from "@/lib/app/methodology";

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));
const day = (v: string | Date) => new Date(v).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Shown while a restatement under the current methodology moved one of the
 * page's numbers: the old value, the new one and why, so a drop reads as a
 * correction rather than a loss. Both values are as of the day they were
 * computed (most are rolling windows), which the note says, so they are not
 * read against today's figure. Nothing renders when no number moved.
 */
export function MethodologyNote({ rows }: { rows: RestatementRow[] }) {
  if (rows.length === 0) return null;
  const change = METHODOLOGY_CHANGES.find((c) => c.version === METHODOLOGY_VERSION);
  const computedAt = rows.reduce((latest, r) => (new Date(r.computed_at) > new Date(latest) ? r.computed_at : latest), rows[0]!.computed_at);
  return (
    <Alert className="mb-4">
      <AlertTitle>How these numbers are counted changed{change ? ` on ${change.date}` : ""}</AlertTitle>
      <AlertDescription>
        <ul className="grid gap-1">
          {rows.map((r) => (
            <li key={r.metric}>
              <span className="text-foreground font-medium">{RESTATED_METRICS[r.metric]?.label ?? r.metric}:</span>{" "}
              <span className="tabular-nums">{fmt(r.old_value)} → {fmt(r.new_value)}</span>. {r.reason}
            </li>
          ))}
        </ul>
        <p className="text-xs">Methodology {METHODOLOGY_VERSION}. Both figures were computed from the same data on {day(computedAt)}; the earlier one is what the previous method gives, and either may differ from today&apos;s.</p>
      </AlertDescription>
    </Alert>
  );
}
