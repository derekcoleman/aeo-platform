/**
 * Minimal stand-in for the PostgREST endpoint middleware resolves sites from.
 *
 * Site resolution happens in middleware, which runs on the edge runtime where
 * the postgres driver is unavailable — so it goes over HTTP. This fixture lets
 * the proxy contract be verified end to end without standing up Supabase.
 *
 *   node tests/fixtures/site-api.mjs [port]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 9999);

const SITES = [
  {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    org_id: "11111111-1111-1111-1111-111111111111",
    canonical_domain: "acme.com",
    path_prefix: "/resources",
    edge_hostname: "acme-8fj2.blogedge.aeo.app",
    proxy_mode: "cloudflare_worker",
    // Optional: lets a local run exercise the signed telemetry path against a real database.
    proxy_hmac_secret: process.env.AEO_FIXTURE_HMAC_SECRET ?? null,
    trailing_slash: "never",
    locale: "en-US",
    status: "active",
    site_domains: [{ hostname: "acme.com" }, { hostname: "www.acme.com" }],
  },
  {
    id: "bbbbbbbb-0000-0000-0000-000000000002",
    org_id: "22222222-2222-2222-2222-222222222222",
    canonical_domain: "globex.com",
    path_prefix: "/blog",
    edge_hostname: "globex-2k9x.blogedge.aeo.app",
    proxy_mode: "vercel_rewrite",
    trailing_slash: "never",
    locale: "en-US",
    status: "active",
    site_domains: [{ hostname: "globex.com" }],
  },
];

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const wanted = (url.searchParams.get("edge_hostname") ?? "").replace(/^eq\./, "");
  const match = SITES.filter((s) => s.edge_hostname === wanted);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(match));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`site-api fixture listening on ${PORT}`);
});
