import type { Metadata, Route } from "next";
import Link from "next/link";
import { Bot, FileSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditForm } from "./audit-form";

export const metadata: Metadata = {
  title: "Free AEO audit — how ready is your site for AI answers?",
  description:
    "Scan any domain for AI-crawler access, schema, passage citability, E-E-A-T and llms.txt. Shareable report in a few minutes.",
};

const CHECKS = [
  { icon: Bot, title: "Can AI crawlers reach it?", body: "robots.txt and llms.txt read the way GPTBot, ClaudeBot and PerplexityBot read them, path by path, not just the root." },
  { icon: FileSearch, title: "Can a passage be lifted into an answer?", body: "Structured data, direct answer blocks, question headings and how well each page stands on its own." },
  { icon: ShieldCheck, title: "Does it carry trust signals?", body: "Named authors, dates, citations and the technical foundation answer engines are trained to prefer." },
];

export default function AuditPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Link href="/" className="font-semibold tracking-tight">AEO Platform</Link>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost"><Link href={"/login" as Route}>Sign in</Link></Button>
        </nav>
      </header>

      <section className="grid flex-1 gap-10 py-10 lg:grid-cols-[1.1fr_1fr] lg:items-start lg:py-16">
        <div className="flex flex-col gap-6">
          <p className="text-muted-foreground text-sm font-medium">Free AEO audit</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">How visible is your site to AI answers?</h1>
          <p className="text-muted-foreground max-w-xl text-lg">
            We crawl up to a dozen pages and score them the way an answer engine would. You get a score out of 100, the breakdown behind it, and the fixes in priority order.
          </p>
          <ul className="grid gap-5 pt-2">
            {CHECKS.map((c) => (
              <li key={c.title} className="flex gap-4">
                <span className="bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg"><c.icon className="size-5" /></span>
                <div>
                  <p className="font-medium">{c.title}</p>
                  <p className="text-muted-foreground text-sm">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl">Scan a website</CardTitle>
            <CardDescription>No signup. The report is shareable for 30 days.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <AuditForm />
            <p className="text-muted-foreground text-xs">We never crawl pages your robots.txt disallows, and we fetch each page once.</p>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
