import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenRouterModelProvider } from "./openrouter.js";

describe("OpenRouterModelProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws a timeout marker when the request exceeds configured timeout", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => {
            const err = Object.assign(new Error("aborted"), { name: "AbortError" });
            reject(err);
          });
        })
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterModelProvider({
      apiKey: "test-key",
      requestTimeoutMs: 5,
    });

    await expect(
      provider.chat({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      })
    ).rejects.toThrow("MODEL_CALL_TIMEOUT");
  });
});
