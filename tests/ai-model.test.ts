import { describe, expect, it } from "vitest";
import { anthropicModel, llmProvider, modelFromEnv, openRouterModel, SERVER_FALLBACK_BETA, supportsEffort, supportsSamplingParams, toOpenRouterModel } from "@/lib/ai/model";
import { estimateCostUsd } from "@/lib/pipeline/model";

function fakeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("toOpenRouterModel", () => {
  it("maps Anthropic ids to OpenRouter slugs", () => {
    expect(toOpenRouterModel("claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(toOpenRouterModel("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(toOpenRouterModel("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(toOpenRouterModel("claude-haiku-4-5-20251001")).toBe("anthropic/claude-haiku-4.5");
    expect(toOpenRouterModel("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
  });

  it("passes full slugs through", () => {
    expect(toOpenRouterModel("openai/gpt-5")).toBe("openai/gpt-5");
    expect(toOpenRouterModel("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });
});

describe("llmProvider", () => {
  it("prefers OpenRouter when both keys are set, honours the override", () => {
    expect(llmProvider({ OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "an" })).toBe("openrouter");
    expect(llmProvider({ OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "an", AEO_LLM_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(llmProvider({ ANTHROPIC_API_KEY: "an" })).toBe("anthropic");
    expect(llmProvider({})).toBeNull();
    expect(llmProvider({ AEO_LLM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "an" })).toBeNull();
  });

  it("modelFromEnv yields an unavailable model without keys", async () => {
    const m = modelFromEnv("claude-opus-5", {});
    expect(m.id).toBe("unavailable");
    await expect(m.complete("hi")).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("openRouterModel", () => {
  it("posts an OpenAI-style request and reads text, tokens and cost back", async () => {
    const { fetch, calls } = fakeFetch({
      model: "anthropic/claude-opus-5",
      choices: [{ message: { content: 'Sure. {"score": 7}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.00123 },
    });
    const model = openRouterModel("claude-opus-5", { apiKey: "or-key", baseUrl: "https://example.test/v1/", referer: "https://app.test", fetchImpl: fetch });
    expect(model.id).toBe("anthropic/claude-opus-5");
    const out = await model.complete("Rate this", { system: "You grade pages.", json: true, maxTokens: 500 });
    expect(out.text).toContain('{"score": 7}');
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 9, model: "anthropic/claude-opus-5", costUsd: 0.00123 });

    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["HTTP-Referer"]).toBe("https://app.test");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("anthropic/claude-opus-5");
    expect(body.max_tokens).toBe(500);
    expect(body.usage).toEqual({ include: true });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/You grade pages\.[\s\S]*single JSON object/);
    expect(body.messages[1]).toEqual({ role: "user", content: "Rate this" });
  });

  it("surfaces provider errors", async () => {
    const { fetch } = fakeFetch({ error: { message: "insufficient credits" } }, 402);
    const model = openRouterModel("claude-opus-5", { apiKey: "k", fetchImpl: fetch });
    await expect(model.complete("x")).rejects.toThrow(/openrouter 402/);
  });
});

describe("anthropicModel", () => {
  it("asks for JSON with an instruction, never an assistant prefill", async () => {
    const { fetch, calls } = fakeFetch({ content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 4 }, model: "claude-opus-5" });
    const out = await anthropicModel("claude-opus-5", "an-key", fetch).complete("Go", { json: true, system: "S" });
    expect(out.text).toBe('{"ok":true}');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages).toEqual([{ role: "user", content: "Go" }]);
    expect(body.system).toMatch(/^S\n\n.*single JSON object/);
  });
});

describe("estimateCostUsd", () => {
  it("prices OpenRouter slugs the same as bare ids", () => {
    expect(estimateCostUsd("anthropic/claude-opus-5", 1_000_000, 0)).toBe(5);
    expect(estimateCostUsd("claude-opus-5", 0, 1_000_000)).toBe(25);
    expect(estimateCostUsd("anthropic/claude-haiku-4.5", 1_000_000, 0)).toBe(1);
  });

  it("matches the longest prefix, so Opus 5.5 is not priced as Opus 5", () => {
    expect(estimateCostUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBe(24);
    expect(estimateCostUsd("anthropic/claude-opus-5.5", 1_000_000, 0)).toBe(4);
    expect(estimateCostUsd("claude-opus-5", 1_000_000, 1_000_000)).toBe(30);
    expect(estimateCostUsd("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12);
    expect(estimateCostUsd("anthropic/claude-haiku-5.5", 1_000_000, 1_000_000)).toBe(0.6);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBe(1);
    expect(estimateCostUsd("claude-sonnet-4-6", 1_000_000, 0)).toBe(3);
  });
});

const CLAUDE_5 = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

describe("sampling parameters", () => {
  it("knows which ids reject them", () => {
    for (const id of [...CLAUDE_5, "anthropic/claude-opus-5.5", "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5-1"]) expect({ id, ok: supportsSamplingParams(id) }).toEqual({ id, ok: false });
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6", "openai/gpt-5", "google/gemini-2.5-pro"]) expect({ id, ok: supportsSamplingParams(id) }).toEqual({ id, ok: true });
  });

  it("are dropped from the Anthropic request body for Claude 5 and kept for Haiku 4.5", async () => {
    for (const id of CLAUDE_5) {
      const { fetch, calls } = fakeFetch({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 }, model: id, stop_reason: "end_turn" });
      await anthropicModel(id, "k", fetch, {}).complete("x", { temperature: 0.3 });
      expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty("temperature");
    }
    const { fetch, calls } = fakeFetch({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-haiku-4-5" });
    await anthropicModel("claude-haiku-4-5", "k", fetch, {}).complete("x", { temperature: 0.3 });
    expect(JSON.parse(String(calls[0]!.init.body)).temperature).toBe(0.3);
  });

  it("are dropped from the OpenRouter body for Claude 5 slugs and kept for other vendors", async () => {
    for (const id of CLAUDE_5) {
      const { fetch, calls } = fakeFetch({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
      await openRouterModel(id, { apiKey: "k", fetchImpl: fetch }).complete("x", { temperature: 0.3 });
      expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty("temperature");
    }
    const { fetch, calls } = fakeFetch({ choices: [{ message: { content: "{}" } }] });
    await openRouterModel("openai/gpt-5", { apiKey: "k", fetchImpl: fetch }).complete("x", { temperature: 0.3 });
    expect(JSON.parse(String(calls[0]!.init.body)).temperature).toBe(0.3);
  });
});

describe("effort", () => {
  it("goes in output_config on the Anthropic API, only for models that take it", async () => {
    expect(supportsEffort("claude-opus-5-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    const a = fakeFetch({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-opus-5-5" });
    await anthropicModel("claude-opus-5-5", "k", a.fetch, {}).complete("x", { effort: "high" });
    const body = JSON.parse(String(a.calls[0]!.init.body));
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("thinking");
    const b = fakeFetch({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-haiku-4-5" });
    await anthropicModel("claude-haiku-4-5", "k", b.fetch, {}).complete("x", { effort: "low" });
    expect(JSON.parse(String(b.calls[0]!.init.body))).not.toHaveProperty("output_config");
  });

  it("is sent to OpenRouter as reasoning.effort only when opted in", async () => {
    const off = fakeFetch({ choices: [{ message: { content: "{}" } }] });
    await openRouterModel("claude-opus-5-5", { apiKey: "k", fetchImpl: off.fetch, reasoning: false }).complete("x", { effort: "high" });
    expect(JSON.parse(String(off.calls[0]!.init.body))).not.toHaveProperty("reasoning");
    const on = fakeFetch({ choices: [{ message: { content: "{}" } }] });
    await openRouterModel("claude-opus-5-5", { apiKey: "k", fetchImpl: on.fetch, reasoning: true }).complete("x", { effort: "high" });
    expect(JSON.parse(String(on.calls[0]!.init.body)).reasoning).toEqual({ effort: "high" });
    const env = fakeFetch({ choices: [{ message: { content: "{}" } }] });
    const prior = process.env.AEO_OPENROUTER_REASONING;
    process.env.AEO_OPENROUTER_REASONING = "1";
    try {
      await openRouterModel("claude-opus-5-5", { apiKey: "k", fetchImpl: env.fetch }).complete("x", { effort: "low" });
    } finally {
      if (prior === undefined) delete process.env.AEO_OPENROUTER_REASONING;
      else process.env.AEO_OPENROUTER_REASONING = prior;
    }
    expect(JSON.parse(String(env.calls[0]!.init.body)).reasoning).toEqual({ effort: "low" });
  });
});

describe("server-side refusal fallbacks", () => {
  const reply = { content: [], usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-opus-5-5" };

  it("are requested for Opus 5.5 / Opus 5 / Sonnet 5.5 with the beta header and the default form", async () => {
    for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]) {
      const { fetch, calls } = fakeFetch(reply);
      await anthropicModel(id, "k", fetch, {}).complete("x");
      expect((calls[0]!.init.headers as Record<string, string>)["anthropic-beta"]).toBe(SERVER_FALLBACK_BETA);
      expect(JSON.parse(String(calls[0]!.init.body)).fallbacks).toBe("default");
    }
    expect(SERVER_FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
  });

  it("are not sent for Haiku 5.5 (it has none), nor when switched off", async () => {
    const haiku = fakeFetch(reply);
    await anthropicModel("claude-haiku-5-5", "k", haiku.fetch, {}).complete("x");
    expect(haiku.calls[0]!.init.headers).not.toHaveProperty("anthropic-beta");
    expect(JSON.parse(String(haiku.calls[0]!.init.body))).not.toHaveProperty("fallbacks");
    const off = fakeFetch(reply);
    await anthropicModel("claude-opus-5-5", "k", off.fetch, { AEO_ANTHROPIC_FALLBACKS: "0" }).complete("x");
    expect(off.calls[0]!.init.headers).not.toHaveProperty("anthropic-beta");
    expect(JSON.parse(String(off.calls[0]!.init.body))).not.toHaveProperty("fallbacks");
  });
});

describe("stop reasons", () => {
  it("are read from Anthropic, with the refusal category and cache tokens", async () => {
    const usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };
    const cases: [Record<string, unknown>, string, string | null][] = [
      [{ stop_reason: "end_turn" }, "end_turn", null],
      [{ stop_reason: "max_tokens" }, "max_tokens", null],
      [{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } }, "refusal", "cyber"],
      [{ stop_reason: "pause_turn" }, "other", null],
    ];
    for (const [extra, stopReason, category] of cases) {
      const { fetch } = fakeFetch({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "ok" }], usage, model: "claude-opus-5-5", ...extra });
      const out = await anthropicModel("claude-opus-5-5", "k", fetch, {}).complete("x");
      expect(out).toMatchObject({ text: "ok", stopReason, refusalCategory: category, usage: { cacheReadTokens: 7, cacheWriteTokens: 3 } });
    }
  });

  it("are mapped from OpenRouter's normalised finish reasons", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ finish_reason: "stop" }, "end_turn"],
      [{ finish_reason: "length" }, "max_tokens"],
      [{ finish_reason: "content_filter" }, "refusal"],
      [{ finish_reason: "stop", native_finish_reason: "refusal" }, "refusal"],
      [{ finish_reason: "error" }, "other"],
    ];
    for (const [choice, stopReason] of cases) {
      const { fetch } = fakeFetch({ choices: [{ message: { content: "{}" }, ...choice }], usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } } });
      const out = await openRouterModel("claude-opus-5-5", { apiKey: "k", fetchImpl: fetch }).complete("x");
      expect({ choice, stopReason: out.stopReason }).toEqual({ choice, stopReason });
      expect(out.usage.cacheReadTokens).toBe(4);
    }
  });
});
