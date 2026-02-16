import crypto from "node:crypto";

import type { SearchAdapter, SearchQueryOptions, SearchResult } from "@openresearch/core";

type JsonCache = {
  getJson<T>(namespace: string, key: string): Promise<T | null>;
  setJson<T>(namespace: string, key: string, value: T): Promise<void>;
};

function sha256Base64url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export class SearxngSearchAdapter implements SearchAdapter {
  readonly name = "searxng";
  private readonly baseUrl: string;
  private readonly userAgent: string | undefined;
  private readonly maxResultsPerQuery: number;
  private readonly cache: JsonCache | undefined;

  constructor(opts: {
    baseUrl: string;
    userAgent?: string;
    maxResultsPerQuery?: number;
    cache?: JsonCache;
  }) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.userAgent = opts.userAgent;
    this.maxResultsPerQuery = opts.maxResultsPerQuery ?? 10;
    this.cache = opts.cache;
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? this.maxResultsPerQuery;
    const language = options?.language;
    const safeSearch = options?.safeSearch;
    const recencyDays = options?.recencyDays;

    const cacheKey = sha256Base64url(
      JSON.stringify({
        backend: this.name,
        query,
        options: { maxResults, language, safeSearch, recencyDays },
      })
    );
    const cached = await this.cache?.getJson<SearchResult[]>("search", cacheKey);
    if (cached) return cached;

    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    if (language) url.searchParams.set("language", language);
    if (safeSearch !== undefined) url.searchParams.set("safesearch", safeSearch ? "2" : "0");
    if (recencyDays !== undefined) url.searchParams.set("time_range", `${recencyDays}d`);

    const init: RequestInit = {};
    if (this.userAgent) init.headers = { "user-agent": this.userAgent };
    const res = await fetch(url.toString(), init);
    if (!res.ok) {
      const hint =
        res.status === 403
          ? " (hint: your SearXNG instance may have JSON output disabled; enable `search.formats: [html, json]` in settings.yml)"
          : "";
      throw new Error(`SearXNG error: ${res.status} ${res.statusText}${hint}`);
    }

    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results =
      data.results?.slice(0, maxResults).map((r): SearchResult => {
        const url = typeof r.url === "string" ? r.url : "";
        const title = typeof r.title === "string" ? r.title : undefined;
        const snippet = typeof r.content === "string" ? r.content : undefined;
        const publishedAt =
          typeof r.publishedDate === "string"
            ? r.publishedDate
            : typeof r.published_at === "string"
              ? r.published_at
              : undefined;
        const out: SearchResult = { url };
        if (title) out.title = title;
        if (snippet) out.snippet = snippet;
        if (publishedAt) out.publishedAt = publishedAt;
        return out;
      }) ?? [];

    const cleaned = results.filter((r) => Boolean(r.url));
    await this.cache?.setJson("search", cacheKey, cleaned);
    return cleaned;
  }
}

export class BraveSearchAdapter implements SearchAdapter {
  readonly name = "brave";
  private readonly apiKey: string;
  private readonly userAgent: string | undefined;
  private readonly maxResultsPerQuery: number;
  private readonly cache: JsonCache | undefined;

  constructor(opts: {
    apiKey: string;
    userAgent?: string;
    maxResultsPerQuery?: number;
    cache?: JsonCache;
  }) {
    this.apiKey = opts.apiKey;
    this.userAgent = opts.userAgent;
    this.maxResultsPerQuery = opts.maxResultsPerQuery ?? 10;
    this.cache = opts.cache;
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? this.maxResultsPerQuery;
    const language = options?.language;
    const safeSearch = options?.safeSearch;
    const recencyDays = options?.recencyDays;

    const cacheKey = sha256Base64url(
      JSON.stringify({
        backend: this.name,
        query,
        options: { maxResults, language, safeSearch, recencyDays },
      })
    );
    const cached = await this.cache?.getJson<SearchResult[]>("search", cacheKey);
    if (cached) return cached;

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    if (language) url.searchParams.set("search_lang", language);
    if (safeSearch !== undefined) url.searchParams.set("safesearch", safeSearch ? "strict" : "off");

    const res = await fetch(url.toString(), {
      headers: {
        "x-subscription-token": this.apiKey,
        ...(this.userAgent ? { "user-agent": this.userAgent } : {}),
      },
    });
    if (!res.ok) throw new Error(`Brave Search error: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    const results =
      data.web?.results?.slice(0, maxResults).map((r): SearchResult => {
        const url = typeof r.url === "string" ? r.url : "";
        const title = typeof r.title === "string" ? r.title : undefined;
        const snippet =
          typeof r.description === "string"
            ? r.description
            : typeof r.snippet === "string"
              ? r.snippet
              : undefined;
        const publishedAt = typeof r.page_age === "string" ? r.page_age : undefined;
        const out: SearchResult = { url };
        if (title) out.title = title;
        if (snippet) out.snippet = snippet;
        if (publishedAt) out.publishedAt = publishedAt;
        return out;
      }) ?? [];

    const cleaned = results.filter((r) => Boolean(r.url));
    await this.cache?.setJson("search", cacheKey, cleaned);
    return cleaned;
  }
}
