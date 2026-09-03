import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScoredJsonError, extractJsonObject, parseScoredJson } from "@/lib/ai/scored-json";

const schema = z.object({ score: z.number().min(0).max(30).catch(0), note: z.string().optional() });

describe("parseScoredJson", () => {
  it("parses plain JSON", () => {
    expect(parseScoredJson('{"score": 12}', schema)).toEqual({ score: 12 });
  });
  it("strips code fences and trailing prose", () => {
    expect(parseScoredJson('Here you go:\n```json\n{"score": 5, "note": "a}b"}\n```\nHope that helps', schema)).toEqual({ score: 5, note: "a}b" });
    expect(parseScoredJson('Result: {"score": 7} and some more words {', schema)).toEqual({ score: 7 });
  });
  it("clamps via schema, not the parser", () => {
    expect(parseScoredJson('{"score": 999}', schema).score).toBe(0);
  });
  it("throws a typed error on garbage", () => {
    expect(() => parseScoredJson("no json here", schema)).toThrow(ScoredJsonError);
    expect(() => parseScoredJson('{"score": "high"}', z.object({ score: z.number() }))).toThrow(/schema mismatch/);
  });
  it("extractJsonObject handles nested braces inside strings", () => {
    expect(extractJsonObject('x {"a": "{", "b": [1, {"c": 2}]} y')).toBe('{"a": "{", "b": [1, {"c": 2}]}');
  });
});
