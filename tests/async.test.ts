import { describe, expect, it } from "vitest";
import { withTimeout } from "@/lib/async";

describe("withTimeout", () => {
  it("passes through a value that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it("rejects with a timeout error when the promise hangs", async () => {
    const never = new Promise<void>(() => {});
    await expect(withTimeout(never, 10)).rejects.toThrow(/timed out/i);
  });

  it("propagates the underlying rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });
});
