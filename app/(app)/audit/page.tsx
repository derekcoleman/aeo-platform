import type { Metadata } from "next";
import { AuditForm } from "./audit-form";

export const metadata: Metadata = {
  title: "Free AEO audit — how ready is your site for AI answers?",
  description:
    "Scan any domain for AI-crawler access, schema, passage citability, E-E-A-T and llms.txt. Shareable report in a few minutes.",
};

export default function AuditPage() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", maxWidth: "44rem" }}>
      <h1>How visible is your site to AI answers?</h1>
      <p>
        We crawl up to a dozen pages and score them the way an answer engine would: can AI crawlers
        reach the content, is it structured so a passage can be lifted verbatim into an answer, and does
        it carry the trust signals models are trained to prefer.
      </p>
      <AuditForm />
      <p style={{ color: "#666", fontSize: "0.9rem", marginTop: "2rem" }}>
        No signup. Reports are shareable for 30 days. We never crawl pages your robots.txt disallows.
      </p>
    </main>
  );
}
