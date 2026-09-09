import { describe, expect, it } from "vitest";
import { anthropicModel, llmProvider, modelFromEnv, openRouterModel, toOpenRouterModel } from "@/lib/ai/model";
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
    const out = await model.complete("Rate this", { system: "You grade pages.", json: true, maxTokens: 500, temperature: 0.2 });
    expect(out.text).toContain('{"score": 7}');
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 9, model: "anthropic/claude-opus-5", costUsd: 0.00123 });

    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["HTTP-Referer"]).toBe("https://app.test");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("anthropic/claude-opus-5");
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0.2);
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
});
