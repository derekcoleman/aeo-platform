import { describe, expect, it } from "vitest";
import { CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS, chunkByHeadings, chunkDocument, chunkSlackThread, chunkWindow, SLACK_REPLY_SEP } from "@/lib/context/chunk";

const sentence = (i: number) => `Sentence number ${i} says something reasonably specific about provisioning.`;

describe("chunkWindow", () => {
  it("returns one chunk for short text and never exceeds the cap", () => {
    expect(chunkWindow("Short. Text.")).toHaveLength(1);
    const long = Array.from({ length: 80 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkWindow(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("carries overlap so a sentence at a boundary appears whole in the next chunk", () => {
    const long = Array.from({ length: 40 }, (_, i) => sentence(i)).join(" ");
    const [a, b] = chunkWindow(long);
    const lastOfA = a!.text.slice(a!.text.lastIndexOf("Sentence number"));
    expect(b!.text.startsWith(lastOfA.split(" ").slice(-3).join(" ")) || b!.text.includes(lastOfA.slice(0, 20))).toBe(true);
    expect(a!.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 200);
  });

  it("hard-splits a single sentence longer than the cap", () => {
    const giant = "x".repeat(CHUNK_MAX_CHARS * 2 + 10);
    expect(chunkWindow(giant).every((c) => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
  });
});

describe("chunkByHeadings", () => {
  it("one chunk per section, prefixed with its heading path", () => {
    const md = "# Guide\n\nIntro para.\n\n## Setup\n\nInstall it.\n\n### Linux\n\nUse apt.\n\n## Usage\n\nRun it.";
    const chunks = chunkByHeadings(md);
    expect(chunks.map((c) => c.text)).toEqual(["Guide\n\nIntro para.", "Guide > Setup\n\nInstall it.", "Guide > Setup > Linux\n\nUse apt.", "Guide > Usage\n\nRun it."]);
    expect(chunks[2]!.metadata.headingPath).toEqual(["Guide", "Setup", "Linux"]);
  });
});

describe("chunkSlackThread", () => {
  it("keeps a short thread whole", () => {
    const t = `[#eng] <dana> we shipped SCIM${SLACK_REPLY_SEP}<lee> nice${SLACK_REPLY_SEP}<sam> docs?`;
    expect(chunkSlackThread(t)).toHaveLength(1);
  });

  it("splits a long thread on reply boundaries and repeats the root on continuations", () => {
    const root = "[#sales] <dana> Prospect asked whether SCIM is on every plan";
    const replies = Array.from({ length: 30 }, (_, i) => `<user${i}> ${sentence(i)} ${sentence(i + 100)}`);
    const chunks = chunkSlackThread([root, ...replies].join(SLACK_REPLY_SEP));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.text.startsWith(root)).toBe(true);
    expect(chunks[0]!.metadata.continuation).toBe(false);
    for (const c of chunks.slice(1)) {
      expect(c.text.startsWith(`${root} (thread continued)`)).toBe(true);
      expect(c.metadata.continuation).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // No reply lost, none duplicated.
    const all = chunks.map((c) => c.text).join("\n");
    for (const r of replies) expect(all.split(r).length - 1).toBe(1);
  });
});

describe("chunkDocument", () => {
  it("dispatches by kind then by shape and stamps provenance metadata", () => {
    const slack = chunkDocument({ kind: "slack_thread", provider: "slack", title: null, text: "[#eng] <dana> hi" });
    expect(slack[0]!.metadata).toEqual({ kind: "slack_thread", provider: "slack" });
    const headed = chunkDocument({ kind: "doc", provider: "google", title: "Runbook", text: "# A\n\nx\n\n# B\n\ny" });
    expect(headed).toHaveLength(2);
    const plain = chunkDocument({ kind: "profound_export", provider: "profound", title: "Prompt set", text: "some rows" });
    expect(plain[0]!.text).toBe("Prompt set\n\nsome rows");
    expect(chunkDocument({ kind: "x", provider: "slack", title: null, text: "   " })).toEqual([]);
  });
});
