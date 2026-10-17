import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnswerEngineConfigError,
  answerEngines,
  answerEngineSlug,
  answerPanelSize,
  answerSamples,
  answerSurface,
  DEFAULT_ANSWER_ENGINES,
  PROBE_LABEL,
  searchTag,
} from "@/lib/answers/engines";
import { NATIVE_PROVIDERS } from "@/lib/demand/store";

describe("answerEngines", () => {
  it("defaults to ChatGPT's, Perplexity's, Gemini's and Claude's models through OpenRouter, each labelled as the API, not the app", () => {
    const engines = answerEngines({});
    expect(engines.map((e) => [e.engine, e.model, e.search])).toEqual([
      ["chatgpt", "openai/gpt-5-mini", "server_tool"],
      ["perplexity", "perplexity/sonar", "native_model"],
      ["gemini", "google/gemini-2.5-flash", "server_tool"],
      ["claude", "anthropic/claude-sonnet-5.5", "server_tool"],
    ]);
    for (const e of engines) expect(e.label).toMatch(/via API \(not the .+\)/);
    expect(PROBE_LABEL).toBe("API-grounded probe, not the consumer app");
  });

  it("merges a partial override over a known engine and takes a new engine that says everything", () => {
    const grok = { model: "x-ai/grok-4", label: "Grok via API (not the Grok app)", search: "server_tool", searchEngine: "native", maxResults: 5, maxTokens: 4000, estimateUsd: 0.05 };
    const engines = answerEngines({ AEO_ANSWER_ENGINES: JSON.stringify({ chatgpt: { model: "openai/gpt-5", maxTokens: 6000 }, grok }) });
    expect(engines.map((e) => e.engine)).toEqual(["chatgpt", "perplexity", "gemini", "claude", "grok"]);
    expect(engines[0]).toMatchObject({ engine: "chatgpt", model: "openai/gpt-5", maxTokens: 6000, label: DEFAULT_ANSWER_ENGINES.chatgpt!.label, search: "server_tool" });
    expect(engines[4]).toMatchObject({ engine: "grok", ...grok });
  });

  it("runs only the engines AEO_ANSWER_ENGINES_ENABLED names, in the usual order", () => {
    expect(answerEngines({ AEO_ANSWER_ENGINES_ENABLED: " Claude, perplexity ,," }).map((e) => e.engine)).toEqual(["perplexity", "claude"]);
  });

  it("refuses a value that does not validate instead of falling back to a default", () => {
    const bad = (env: Record<string, string>) => () => answerEngines(env);
    expect(bad({ AEO_ANSWER_ENGINES: "{not json" })).toThrow(AnswerEngineConfigError);
    expect(bad({ AEO_ANSWER_ENGINES: "[]" })).toThrow(/object of engine/);
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ "Chat GPT": { model: "openai/gpt-5" } }) })).toThrow(/lower-case/);
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ chatgpt: { model: "gpt-5" } }) })).toThrow(/chatgpt: model/);
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ chatgpt: { search: "browse" } }) })).toThrow(/chatgpt: search/);
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ chatgpt: { maxResults: 40 } }) })).toThrow(/maxResults/);
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ chatgpt: { temperature: 0 } }) })).toThrow(/temperature/);
    // A new engine must say everything.
    expect(bad({ AEO_ANSWER_ENGINES: JSON.stringify({ grok: { model: "x-ai/grok-4" } }) })).toThrow(/grok: /);
    expect(bad({ AEO_ANSWER_ENGINES_ENABLED: "chatgpt,bard" })).toThrow(/unknown engines: bard/);
  });
});

describe("probe settings", () => {
  it("samples once per prompt by default, at most three times; the panel is 25 prompts unless set", () => {
    expect([answerSamples({}), answerSamples({ AEO_ANSWER_SAMPLES: "3" }), answerSamples({ AEO_ANSWER_SAMPLES: "9" }), answerSamples({ AEO_ANSWER_SAMPLES: "" }), answerSamples({ AEO_ANSWER_SAMPLES: "x" })]).toEqual([1, 3, 3, 1, 1]);
    expect([answerPanelSize({}), answerPanelSize({ AEO_ANSWER_PANEL_SIZE: "10" }), answerPanelSize({ AEO_ANSWER_PANEL_SIZE: "0" }), answerPanelSize({ AEO_ANSWER_PANEL_SIZE: "500" })]).toEqual([25, 10, 1, 100]);
  });

  it("tags how a model searched", () => {
    const tag = (search: string, searchEngine: string | null = null) => searchTag({ search, searchEngine } as never);
    expect([tag("server_tool", "native"), tag("plugin", "exa"), tag("server_tool"), tag("online_suffix"), tag("native_model"), tag("none")]).toEqual(["+web:native", "+web:exa", "+web:auto", "+online", "+native", "+none"]);
  });
});

describe("engines and surfaces", () => {
  it("slugs an engine name as measure.engine_slug does", () => {
    expect([answerEngineSlug("Google AI Overview"), answerEngineSlug("chatgpt"), answerEngineSlug("  _x__y_ "), answerEngineSlug(""), answerEngineSlug(null)]).toEqual(["google_ai_overview", "chatgpt", "x_y", "unknown", "unknown"]);
  });

  it("puts Google AI Overview citations on ai_overview, AI Mode's on ai_mode and every other engine's on llm_answer", () => {
    expect([answerSurface("google_aio"), answerSurface("ai_mode"), answerSurface("chatgpt"), answerSurface("gemini"), answerSurface("unknown")]).toEqual(["ai_overview", "ai_mode", "llm_answer", "llm_answer", "llm_answer"]);
  });

  it("v_native_aio holds exactly NATIVE_PROVIDERS' SERP rows", () => {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations/0024_answer_ledger.sql"), "utf8");
    const view = /create view measure\.v_native_aio[\s\S]*?where s\.collection_method = 'serp' and s\.provider in \(([^)]*)\);/.exec(migration);
    expect(view).not.toBeNull();
    expect(view![1]!.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...NATIVE_PROVIDERS]);
  });
});
