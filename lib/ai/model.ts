/**
 * The narrowest model interface the audit needs: text in, text out, with a
 * usage record. The full ModelRouter (task_key → model/params/budget, config
 * in ops.model_routes) lands with the pipeline; the audit only needs to be
 * pluggable so tests can inject a fake and Inngest steps can pass a real one.
 */

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Provider JSON mode / prefill hint. Callers still validate with Zod. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface TextModel {
  readonly id: string;
  complete(prompt: string, opts?: CompletionOptions): Promise<{ text: string; usage: CompletionUsage }>;
}

export const DEFAULT_AUDIT_MODEL = process.env.AEO_AUDIT_MODEL ?? "claude-sonnet-5";

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

/** Direct Messages API client. No SDK dependency; one fetch, one shape. */
export function anthropicModel(model = DEFAULT_AUDIT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY): TextModel {
  return {
    id: model,
    async complete(prompt, opts = {}) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: prompt }];
      // Prefill the opening brace so the model emits bare JSON; we prepend it back.
      if (opts.json) messages.push({ role: "assistant", content: "{" });
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: opts.signal ?? null,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0,
          ...(opts.system ? { system: opts.system } : {}),
          messages,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as AnthropicResponse;
      const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return {
        text: opts.json ? "{" + text : text,
        usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, model: data.model },
      };
    },
  };
}

/** A model that always fails. The audit's degraded path when no key is configured. */
export function unavailableModel(reason = "no model configured"): TextModel {
  return {
    id: "unavailable",
    async complete() {
      throw new Error(reason);
    },
  };
}

export function defaultModel(): TextModel {
  return process.env.ANTHROPIC_API_KEY ? anthropicModel() : unavailableModel("ANTHROPIC_API_KEY is not set");
}
