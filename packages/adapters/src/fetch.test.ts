import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpFetchAdapterImpl } from "./fetch.js";

describe("http fetch adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches and caches successful responses", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const m = new Map<string, unknown>();
    const cache = {
      async getJson<T>(_ns: string, key: string): Promise<T | null> {
        return (m.get(key) as T | undefined) ?? null;
      },
      async setJson<T>(_ns: string, key: string, value: T): Promise<void> {
        m.set(key, value);
      },
    };

    const adapter = new HttpFetchAdapterImpl({
      cache,
      defaultMaxBytes: 1024,
      defaultTimeoutMs: 10_000,
      maxRetries: 0,
    });
    const a = await adapter.fetch("https://example.com");
    const b = await adapter.fetch("https://example.com");

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
