import { afterEach, describe, expect, it, vi } from "vitest";

import { BraveSearchAdapter, SearxngSearchAdapter } from "./search.js";

type JsonCache = {
  getJson<T>(namespace: string, key: string): Promise<T | null>;
  setJson<T>(namespace: string, key: string, value: T): Promise<void>;
};

function memCache(): JsonCache {
  const m = new Map<string, unknown>();
  return {
    async getJson<T>(_ns: string, key: string): Promise<T | null> {
      return (m.get(key) as T | undefined) ?? null;
    },
    async setJson<T>(_ns: string, key: string, value: T): Promise<void> {
      m.set(key, value);
    },
  };
}

describe("search adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses SearXNG JSON results and caches by key", async () => {
    const cache = memCache();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: [
            { url: "https://example.com/a", title: "A", content: "Snippet A" },
            { url: "https://example.com/b", title: "B", content: "Snippet B" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SearxngSearchAdapter({
      baseUrl: "http://searxng.local",
      cache,
      maxResultsPerQuery: 10,
    });
    const first = await adapter.search("q");
    const second = await adapter.search("q");

    expect(first).toEqual(second);
    expect(first[0]?.url).toBe("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses Brave Search JSON results", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get("x-subscription-token")).toBe("brave-key");
      return new Response(
        JSON.stringify({
          web: { results: [{ url: "https://example.com/x", title: "X", description: "Desc" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BraveSearchAdapter({ apiKey: "brave-key" });
    const results = await adapter.search("q");
    expect(results[0]?.url).toBe("https://example.com/x");
  });
});
