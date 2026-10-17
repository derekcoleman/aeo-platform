import { describe, expect, it } from "vitest";
import { answerEngines, type AnswerEngineConfig } from "@/lib/answers/engines";
import { AnswerProbeError, extractCitations, probeAnswer, probeRequestBody, storableText, unusableAnswer } from "@/lib/answers/openrouter-probe";
import { fakeFetch } from "./helpers/fake-fetch";

const BASE = "https://or.test/api/v1";
const engines = Object.fromEntries(answerEngines({}).map((e) => [e.engine, e])) as Record<string, AnswerEngineConfig>;
const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const PROMPT = "What is the best SSO provider for a 200-person company?";
/** The error a probe failed with; a probe that succeeds fails the test. */
const failure = (p: Promise<unknown>): Promise<AnswerProbeError> =>
  p.then(
    () => {
      throw new Error("expected the probe to fail");
    },
    (e: unknown) => e as AnswerProbeError,
  );

describe("probeRequestBody", () => {
  it("sends the prompt as the only message, with no system prompt and no sampling parameters", () => {
    for (const cfg of Object.values(engines)) {
      const body = probeRequestBody(cfg, PROMPT);
      expect(body.messages).toEqual([{ role: "user", content: PROMPT }]);
      for (const k of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed", "reasoning"]) expect(body).not.toHaveProperty(k);
      expect(body).toMatchObject({ max_tokens: cfg.maxTokens, usage: { include: true } });
    }
  });

  it("asks for web search the way each mode says", () => {
    expect(probeRequestBody(engines.chatgpt!, PROMPT)).toMatchObject({
      model: "openai/gpt-5-mini",
      tools: [{ type: "openrouter:web_search", parameters: { engine: "native", max_results: 5 } }],
    });
    const sonar = probeRequestBody(engines.perplexity!, PROMPT);
    expect(sonar.model).toBe("perplexity/sonar");
    expect(sonar).not.toHaveProperty("tools");
    expect(sonar).not.toHaveProperty("plugins");
    expect(probeRequestBody({ ...engines.gemini!, search: "plugin", searchEngine: "exa", maxResults: 8 }, PROMPT)).toMatchObject({ plugins: [{ id: "web", engine: "exa", max_results: 8 }] });
    const online = probeRequestBody({ ...engines.chatgpt!, search: "online_suffix" }, PROMPT);
    expect(online.model).toBe("openai/gpt-5-mini:online");
    expect(online).not.toHaveProperty("tools");
    expect(probeRequestBody({ ...engines.claude!, search: "server_tool", searchEngine: null }, PROMPT).tools).toEqual([{ type: "openrouter:web_search", parameters: { max_results: 5 } }]);
    expect(probeRequestBody({ ...engines.claude!, search: "none" }, PROMPT)).not.toHaveProperty("tools");
  });
});

describe("probeAnswer", () => {
  it("posts to OpenRouter with the key and attribution headers, and reads the answer, sources, cost and finish back", async () => {
    const text = "Okta is the usual pick [source](https://www.okta.com/sso). See also https://acme.com/resources/sso.";
    const f = fakeFetch({
      [`${BASE}/chat/completions`]: json({
        id: "gen-1",
        model: "openai/gpt-5-mini-2026-08",
        provider: "OpenAI",
        choices: [{
          finish_reason: "stop",
          native_finish_reason: "completed",
          message: {
            content: text,
            annotations: [
              { type: "url_citation", url_citation: { url: "https://acme.com/resources/sso", title: "Acme SSO", content: "Acme does SSO", start_index: 60 } },
              { type: "url_citation", url_citation: { url: "https://www.okta.com/sso", title: "Okta", start_index: 0 } },
              { type: "url_citation", url_citation: { url: "https://www.okta.com/sso", start_index: 30 } },
              { type: "file", file: {} },
            ],
          },
        }],
        usage: { prompt_tokens: 40, completion_tokens: 300, cost: 0.0123 },
      }),
    });
    const out = await probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "or-key", baseUrl: `${BASE}/`, referer: "https://app.test", fetchImpl: f.fetchImpl, now: () => new Date("2026-10-13T10:00:00Z") });
    const call = f.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer or-key");
    expect(call.headers["http-referer"]).toBe("https://app.test");
    expect(call.headers["x-title"]).toBe("AEO Platform");
    expect(JSON.parse(call.body!)).toEqual(probeRequestBody(engines.chatgpt!, PROMPT));
    expect(out).toMatchObject({
      engine: "chatgpt",
      requestedModel: "openai/gpt-5-mini",
      model: "openai/gpt-5-mini-2026-08",
      text,
      citationSource: "annotation",
      citationsObservable: true,
      finishReason: "stop",
      nativeFinishReason: "completed",
      stopReason: "end_turn",
      usage: { inputTokens: 40, outputTokens: 300, costUsd: 0.0123 },
      upstreamProvider: "OpenAI",
      responseId: "gen-1",
      fetchedAt: "2026-10-13T10:00:00.000Z",
    });
    // Listed in the engine's order, deduplicated, ranked by where the text first refers to each.
    expect(out.citations.map((c) => [c.domain, c.position, c.positionInAnswer, c.title])).toEqual([
      ["acme.com", 1, 2, "Acme SSO"],
      ["okta.com", 2, 1, "Okta"],
    ]);
    expect(out.citations[0]!.snippet).toBe("Acme does SSO");
  });

  it("maps finish reasons: length is a cut-off, content_filter a refusal", async () => {
    const run = async (finish: string, native: string | null = null) => {
      const f = fakeFetch({ [`${BASE}/chat/completions`]: json({ choices: [{ finish_reason: finish, native_finish_reason: native, message: { content: "x" } }] }) });
      return (await probeAnswer(engines.perplexity!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: f.fetchImpl })).stopReason;
    };
    expect(await run("length")).toBe("max_tokens");
    expect(await run("content_filter")).toBe("refusal");
    expect(await run("stop", "refusal")).toBe("refusal");
    expect(await run("stop")).toBe("end_turn");
    expect(await run("error")).toBe("other");
  });

  it("is not observable when the engine exposed no source at all, and says the cost was not reported", async () => {
    const f = fakeFetch({ [`${BASE}/chat/completions`]: json({ model: "anthropic/claude-sonnet-5.5", choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: "Okta is a common choice." }], annotations: [] } }] }) });
    const out = await probeAnswer(engines.claude!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: f.fetchImpl });
    expect(out).toMatchObject({ text: "Okta is a common choice.", citations: [], citationSource: null, citationsObservable: false, usage: { costUsd: null } });
  });

  it("throws an AnswerProbeError that says whether the same request would fail again", async () => {
    const at = (status: number) => fakeFetch({ [`${BASE}/chat/completions`]: { status, body: "nope" } }).fetchImpl;
    const fail = (status: number) => failure(probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: at(status) }));
    const bad = await fail(400);
    expect(bad).toBeInstanceOf(AnswerProbeError);
    expect([bad.status, bad.permanent]).toEqual([400, true]);
    expect((await fail(429)).permanent).toBe(false);
    expect((await fail(503)).permanent).toBe(false);
    const refused = fakeFetch({ [`${BASE}/chat/completions`]: json({ error: { message: "model not found" } }) });
    await expect(probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: refused.fetchImpl })).rejects.toThrow(/model not found/);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const lost = await failure(probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: offline }));
    expect([lost.status, lost.permanent]).toEqual([null, false]);
    await expect(probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "", baseUrl: BASE, fetchImpl: offline })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("unusableAnswer", () => {
  /** What the job is told about a paid response: null when it is an answer to record. */
  const verdict = async (choice: Record<string, unknown>) => {
    const f = fakeFetch({ [`${BASE}/chat/completions`]: json({ model: "openai/gpt-5-mini-2026-08", choices: [choice], usage: { completion_tokens: 4000, cost: 0.03 } }) });
    const e = unusableAnswer(await probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: f.fetchImpl }));
    return e && { permanent: e.permanent, message: e.message };
  };

  it("turns away a response with nothing in it, as permanent when asking again would give the same", async () => {
    // A reasoning model that spent max_tokens thinking: the engine's config needs more room.
    expect(await verdict({ finish_reason: "length", message: { content: "" } })).toEqual({
      permanent: true,
      message: "chatgpt probe: no answer before max_tokens (4000 output tokens spent); raise maxTokens for this engine in AEO_ANSWER_ENGINES",
    });
    expect(await verdict({ finish_reason: "tool_calls", message: { content: null } })).toMatchObject({ permanent: true, message: expect.stringContaining("tool") });
    expect(await verdict({ finish_reason: "content_filter", message: { content: "" } })).toMatchObject({ permanent: true, message: expect.stringContaining("refused") });
    expect(await verdict({ finish_reason: "stop", message: { content: [{ type: "text", text: "  " }] } })).toMatchObject({ permanent: false });
  });

  it("retries an answer that failed upstream, even one that had begun", async () => {
    expect(await verdict({ finish_reason: "error", message: { content: null } })).toMatchObject({ permanent: false });
    expect(await verdict({ finish_reason: "error", native_finish_reason: "overloaded", message: { content: "Okta is" } })).toEqual({ permanent: false, message: "chatgpt probe: the answer failed upstream (overloaded)" });
  });

  it("keeps an answer, even one cut off after it began", async () => {
    expect(await verdict({ finish_reason: "stop", message: { content: "Okta." } })).toBeNull();
    expect(await verdict({ finish_reason: "length", message: { content: "1. Okta\n2. Acme" } })).toBeNull();
  });
});

describe("storableText", () => {
  it("drops NUL and replaces half a surrogate pair, leaving whole characters alone", () => {
    expect(storableText("a\u0000b\udc00c\ud83dd 😀")).toBe("ab\ufffdc\ufffdd 😀");
  });

  it("is applied to the answer and to every source's title and snippet, so Postgres can store them", async () => {
    const text = "Use acme.com\u0000 now \ud83d.";
    const f = fakeFetch({
      [`${BASE}/chat/completions`]: json({
        choices: [{
          finish_reason: "stop",
          message: { content: text, annotations: [{ type: "url_citation", url_citation: { url: "https://acme.com/a", title: "Ac\u0000me", content: `${"x".repeat(499)}😀 tail`, start_index: 0 } }] },
        }],
      }),
    });
    const out = await probeAnswer(engines.chatgpt!, PROMPT, { apiKey: "k", baseUrl: BASE, fetchImpl: f.fetchImpl });
    expect(out.text).toBe("Use acme.com now \ufffd.");
    // The 500-character cut fell inside the emoji: its first half is dropped, not stored alone.
    expect(out.citations.map((c) => [c.title, c.snippet])).toEqual([["Acme", "x".repeat(499)]]);
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud[89a-f][0-9a-f]{2}/);
  });
});

describe("extractCitations", () => {
  it("falls back to the top-level citations list, ranked by the [n] markers", () => {
    const text = "Use JumpCloud [2]. Okta is the enterprise default [1][2].";
    const out = extractCitations({ citations: ["https://okta.com/a", "https://jumpcloud.com/b", "not a url", { url: "https://www.g2.com/c", title: "G2" }] }, text);
    expect(out.source).toBe("citations");
    expect(out.citations.map((c) => [c.domain, c.position, c.positionInAnswer, c.source])).toEqual([
      ["okta.com", 1, 2, "citations"],
      ["jumpcloud.com", 2, 1, "citations"],
      ["g2.com", 3, null, "citations"],
    ]);
    expect(out.citations[2]!.title).toBe("G2");
  });

  it("falls back to links written into the answer: markdown first by position, then bare URLs, trailing punctuation off", () => {
    const text = "See [Okta's guide](https://www.okta.com/guide) and https://reddit.com/r/sso, or [the same](https://www.okta.com/guide).";
    const out = extractCitations({ choices: [{ message: { content: text, annotations: null } }] }, text);
    expect(out.source).toBe("inline_link");
    expect(out.citations.map((c) => [c.url, c.position, c.positionInAnswer, c.title])).toEqual([
      ["https://www.okta.com/guide", 1, 1, "Okta's guide"],
      ["https://reddit.com/r/sso", 2, 2, null],
    ]);
  });

  it("prefers annotations over the other two, and ignores sources that are not web pages", () => {
    const text = "Okta [1]. https://jumpcloud.com/x";
    const out = extractCitations(
      { citations: ["https://onelogin.com/x"], choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { url: "ftp://okta.com/x" } }, { type: "url_citation", url_citation: { url: "https://okta.com/x" } }] } }] },
      text,
    );
    expect(out.citations.map((c) => [c.domain, c.source, c.positionInAnswer])).toEqual([["okta.com", "annotation", null]]);
    expect(extractCitations({}, "no sources here").citations).toEqual([]);
    expect(extractCitations({}, "http://localhost/x").citations).toEqual([]);
  });
});
