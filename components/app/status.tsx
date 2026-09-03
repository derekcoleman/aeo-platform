import { Badge } from "@/components/ui/badge";

export function SiteStatusBadge({ status }: { status: string }) {
  const variant = status === "active" ? "success" : status === "verifying" ? "warning" : status === "provisioning" ? "secondary" : "destructive";
  return <Badge variant={variant}>{status}</Badge>;
}

export function HealthBadge({ ok, failures }: { ok: boolean | null; failures: number }) {
  if (ok === null) return <Badge variant="outline">not checked</Badge>;
  if (ok) return <Badge variant="success">healthy</Badge>;
  return <Badge variant="destructive">failing ×{failures}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict: "allow" | "block" | "challenge" | "error" }) {
  const variant = verdict === "allow" ? "success" : verdict === "block" ? "destructive" : verdict === "challenge" ? "warning" : "outline";
  return <Badge variant={variant}>{verdict}</Badge>;
}

export function when(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
