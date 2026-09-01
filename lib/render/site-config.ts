import { rendererDb } from "./db";
import type { SiteTheme } from "./theme";

/**
 * Site-level render config, materialised into the `content` schema so the
 * least-privilege renderer role can read it without any grant on `app.*`.
 * See migration 0002.
 */
export interface SiteRenderConfig {
  siteId: string;
  canonicalDomain: string;
  pathPrefix: string;
  locale: string;
  trailingSlash: "never" | "always";
  theme: SiteTheme;
  organization: { name?: string; url?: string; logo?: string };
}

export async function getSiteRenderConfig(siteId: string): Promise<SiteRenderConfig | null> {
  const rows = await rendererDb()<
    {
      site_id: string;
      canonical_domain: string;
      path_prefix: string;
      locale: string;
      trailing_slash: "never" | "always";
      theme: SiteTheme;
      organization: SiteRenderConfig["organization"];
    }[]
  >`
    select site_id, canonical_domain, path_prefix, locale, trailing_slash, theme, organization
    from content.site_render_config
    where site_id = ${siteId}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    siteId: row.site_id,
    canonicalDomain: row.canonical_domain,
    pathPrefix: row.path_prefix,
    locale: row.locale,
    trailingSlash: row.trailing_slash,
    theme: row.theme ?? { tokens: {} },
    organization: row.organization ?? {},
  };
}
