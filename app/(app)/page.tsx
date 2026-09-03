import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Radar, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { isAuthConfigured } from "@/lib/auth/supabase";

export const dynamic = "force-dynamic";

/** Signed-in users go straight to their projects; everyone else gets the front door. */
export default async function Home() {
  if (isAuthConfigured()) {
    const user = await currentUser().catch(() => null);
    if (user) redirect("/app" as Route);
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <span className="font-semibold tracking-tight">AEO Platform</span>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost"><Link href="/audit">Free audit</Link></Button>
          <Button asChild><Link href={"/login" as Route}>Sign in</Link></Button>
        </nav>
      </header>
      <section className="flex flex-1 flex-col justify-center gap-6 py-16">
        <p className="text-muted-foreground text-sm font-medium">Agentic AEO / GEO growth</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Growth that compounds in AI answers. Measured, not asserted.</h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          Publish grounded, cite-able content on your own domain in days, and prove which asset moved the AI Overview, the crawler traffic and the pipeline.
        </p>
        <div className="flex gap-3">
          <Button asChild size="lg"><Link href={"/login" as Route}>Create a project <ArrowRight /></Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/audit">Run a free audit</Link></Button>
        </div>
        <ul className="text-muted-foreground mt-8 grid gap-4 text-sm sm:grid-cols-3">
          <li className="flex gap-3"><Radar className="text-foreground size-5 shrink-0" /><span><strong className="text-foreground">Measure.</strong> AI Overview citations, live crawler fetches, AI referrals.</span></li>
          <li className="flex gap-3"><Sparkles className="text-foreground size-5 shrink-0" /><span><strong className="text-foreground">Ground.</strong> Every claim traced to a verified brand fact or a checked source.</span></li>
          <li className="flex gap-3"><ShieldCheck className="text-foreground size-5 shrink-0" /><span><strong className="text-foreground">Publish.</strong> On your domain, through one rewrite, with a health monitor watching it.</span></li>
        </ul>
      </section>
    </main>
  );
}
