"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/app/actions";
import { saveThemeAction } from "@/lib/app/theme-actions";
import type { SiteTheme } from "@/lib/render/theme";

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Side-by-side: the theme fields on the left, the live preview on the right. The preview reflects unsaved edits. */
export function ThemeForm({ siteId, theme }: { siteId: string; theme: SiteTheme }) {
  const [tokens, setTokens] = useState(JSON.stringify(theme.tokens ?? {}, null, 2));
  const [headerHtml, setHeaderHtml] = useState(theme.headerHtml ?? "");
  const [footerHtml, setFooterHtml] = useState(theme.footerHtml ?? "");
  const [customCss, setCustomCss] = useState(theme.customCss ?? "");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveThemeAction, null);
  const previewSrc = useMemo(() => {
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(tokens || "{}") as Record<string, string>;
    } catch {
      /* keep the last good preview */
    }
    const draft: SiteTheme = { tokens: parsed, headerHtml: headerHtml || null, footerHtml: footerHtml || null, customCss: customCss || null };
    return `/app/preview/site/${siteId}?theme=${b64url(JSON.stringify(draft))}`;
  }, [siteId, tokens, headerHtml, footerHtml, customCss]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form action={action} className="grid content-start gap-3">
        <input type="hidden" name="siteId" value={siteId} />
        <div className="grid gap-1">
          <Label htmlFor="theme-tokens">Tokens (JSON: font-sans, bg, fg, muted, link, accent, border, radius, container, …)</Label>
          <Textarea id="theme-tokens" name="tokens" rows={10} className="font-mono text-xs" value={tokens} onChange={(e) => setTokens(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="theme-header">Header HTML (sanitised: no scripts, no inline handlers, no javascript: links)</Label>
          <Textarea id="theme-header" name="headerHtml" rows={6} className="font-mono text-xs" value={headerHtml} onChange={(e) => setHeaderHtml(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="theme-footer">Footer HTML</Label>
          <Textarea id="theme-footer" name="footerHtml" rows={5} className="font-mono text-xs" value={footerHtml} onChange={(e) => setFooterHtml(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="theme-css">Custom CSS (no @import, no expression(), no javascript: urls)</Label>
          <Textarea id="theme-css" name="customCss" rows={6} className="font-mono text-xs" value={customCss} onChange={(e) => setCustomCss(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save theme"}</Button>
          {state ? <span className={`text-xs ${state.ok ? "text-muted-foreground" : "text-destructive"}`}>{state.ok ? "Saved. Published pages pick it up on the next render." : state.error}</span> : null}
        </div>
      </form>
      <div className="grid gap-2">
        <Label>Preview (unsaved edits included)</Label>
        <iframe title="Theme preview" src={previewSrc} className="h-[80vh] w-full rounded-md border bg-white" sandbox="" />
      </div>
    </div>
  );
}
