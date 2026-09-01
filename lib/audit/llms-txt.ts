import type { LlmsTxtResult } from "./types";

/**
 * llms.txt validation against the llmstxt.org shape: an H1 title, an optional
 * blockquote/paragraph description, H2 sections of markdown link lists.
 *
 * Fixed from the port: `valid` is derived from `issues`, so it can no longer
 * be true with a non-empty issue list.
 */
export function validateLlmsTxt(content: string): { valid: boolean; sections: string[]; issues: string[] } {
  const issues: string[] = [];
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);

  if (nonEmpty.length === 0) {
    return { valid: false, sections: [], issues: ["File is empty"] };
  }
  if (/^<!doctype html|^<html/i.test(nonEmpty[0]!)) {
    return { valid: false, sections: [], issues: ["llms.txt returned an HTML page, not a markdown file (likely a soft 404)"] };
  }

  const title = nonEmpty.find((l) => l.startsWith("# "));
  if (!title) issues.push("Missing H1 title line (`# Site name`)");
  else if (nonEmpty[0] !== title) issues.push("H1 title should be the first line");

  const afterTitle = title ? nonEmpty.slice(nonEmpty.indexOf(title) + 1) : nonEmpty;
  const description = afterTitle.find((l) => !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("[") && !l.startsWith("*"));
  if (!description || description.replace(/^>\s*/, "").length < 20) {
    issues.push("Missing or too-short description under the title (aim for one or two sentences)");
  }

  const sections = nonEmpty.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  if (sections.length === 0) issues.push("No `## ` sections — group links by purpose (Docs, Product, Blog…)");

  const links = nonEmpty.filter((l) => /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(l));
  if (links.length === 0) issues.push("No markdown links — llms.txt should point models at your canonical pages");

  const brokenBullets = nonEmpty.filter((l) => /^-\s*$/.test(l)).length;
  if (brokenBullets > 0) issues.push(`${brokenBullets} empty list item(s)`);

  return { valid: issues.length === 0, sections, issues };
}

export function buildLlmsTxtResult(url: string, status: number | null, body: string | null): LlmsTxtResult {
  if (status !== 200 || body === null) {
    return { found: false, url, valid: false, sections: [], issues: ["llms.txt not found"] };
  }
  const v = validateLlmsTxt(body);
  return { found: true, url, ...v };
}
