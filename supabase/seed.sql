-- Development and CI fixtures. Mirrors tests/fixtures/site-api.mjs, which
-- serves the same two sites over HTTP for middleware's edge-runtime lookup.
\set ON_ERROR_STOP on

insert into app.organizations (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Acme',   'acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex', 'globex')
on conflict do nothing;

insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Acme', 'acme.com', '/resources', 'acme-8fj2.blogedge.aeo.app', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'Globex', 'globex.com', '/blog', 'globex-2k9x.blogedge.aeo.app', 'active')
on conflict do nothing;

insert into app.site_domains (org_id, site_id, hostname, is_primary) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'acme.com', true),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'www.acme.com', false)
on conflict do nothing;

-- Theme and organisation details the renderer reads (materialised by 0002's
-- trigger for the site columns; theme is set by the app at publish time).
update content.site_render_config set
  theme = '{"tokens":{"link":"#0055ff","accent":"#0055ff"},
            "headerHtml":"<header><a href=\"/\">Acme</a></header>",
            "footerHtml":"<footer>© Acme</footer>"}'::jsonb,
  organization = '{"name":"Acme","url":"https://acme.com"}'::jsonb
where site_id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into content.published_pages (site_id, path, html, markdown, etag, head) values
('aaaaaaaa-0000-0000-0000-000000000001', '/resources/sso-vs-scim',
 '<p>SCIM provisions accounts. SSO authenticates them. Most teams need both.</p><h2>What is SCIM?</h2><p>A protocol for syncing user records between an identity provider and an application.</p>',
 E'SCIM provisions accounts. SSO authenticates them.\n\n## What is SCIM?\n\nA protocol for syncing user records.',
 'etag-sso-1',
 '{"title":"SSO vs SCIM","description":"What the difference actually is.",
   "datePublished":"2026-08-01T00:00:00.000Z","dateModified":"2026-08-20T00:00:00.000Z",
   "author":{"name":"Dana Reed","url":"https://acme.com/team/dana"},
   "jsonLd":{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"SSO vs SCIM"}]}}'::jsonb),
('bbbbbbbb-0000-0000-0000-000000000002', '/blog/hello',
 '<p>Globex.</p>', '# Hello', 'etag-globex-1',
 '{"title":"Hello"}'::jsonb)
on conflict (site_id, path) do nothing;
