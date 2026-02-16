/// <reference lib="dom" />

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BrowserRenderAdapter,
  BrowserRenderOptions,
  BrowserRenderResult,
  FetchOptions,
  HttpFetchAdapter,
  HttpFetchResult,
} from "@openresearch/core";

type JsonCache = {
  getJson<T>(namespace: string, key: string): Promise<T | null>;
  setJson<T>(namespace: string, key: string, value: T): Promise<void>;
};

type CachedFetch = {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status: number | null;
  contentType?: string | null;
  bodyBase64?: string;
  error?: string;
};

function sha256Base64url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpFetchAdapterImpl implements HttpFetchAdapter {
  readonly name = "http";
  private readonly cache: JsonCache | undefined;
  private readonly userAgent: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxBytes: number;
  private readonly maxRetries: number;

  constructor(opts: {
    cache?: JsonCache;
    userAgent?: string;
    defaultTimeoutMs?: number;
    defaultMaxBytes?: number;
    maxRetries?: number;
  }) {
    this.cache = opts.cache;
    this.userAgent = opts.userAgent;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
    this.defaultMaxBytes = opts.defaultMaxBytes ?? 2_000_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async fetch(url: string, options?: FetchOptions): Promise<HttpFetchResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = options?.maxBytes ?? this.defaultMaxBytes;
    const userAgent = options?.userAgent ?? this.userAgent;
    const extraHeaders = options?.headers;

    const cacheKey = sha256Base64url(
      JSON.stringify({
        backend: this.name,
        url,
        options: { timeoutMs, maxBytes, userAgent, extraHeaders },
      })
    );
    const cached = await this.cache?.getJson<CachedFetch>("fetch", cacheKey);
    if (cached) {
      if (!cached.ok)
        return { ok: false, url, status: cached.status, error: cached.error ?? "cached error" };
      const body = cached.bodyBase64 ? Buffer.from(cached.bodyBase64, "base64") : Buffer.from("");
      return {
        ok: true,
        url: cached.finalUrl ?? url,
        status: cached.status ?? 200,
        contentType: cached.contentType ?? null,
        body,
      };
    }

    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (userAgent) headers["user-agent"] = userAgent;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
        clearTimeout(timeout);

        const status = res.status;
        const contentType = res.headers.get("content-type");
        const ab = await res.arrayBuffer();
        if (ab.byteLength > maxBytes) {
          const out: HttpFetchResult = {
            ok: false,
            url,
            status,
            error: `response too large (${ab.byteLength} bytes)`,
          };
          await this.cache?.setJson("fetch", cacheKey, {
            ok: false,
            url,
            status,
            error: out.error,
          });
          return out;
        }

        if (!res.ok) {
          const out: HttpFetchResult = { ok: false, url, status, error: `HTTP ${status}` };
          if (status >= 500 || status === 429) throw new Error(out.error);
          await this.cache?.setJson("fetch", cacheKey, {
            ok: false,
            url,
            status,
            error: out.error,
          });
          return out;
        }

        const body = Buffer.from(ab);
        const out: HttpFetchResult = { ok: true, url: res.url || url, status, contentType, body };
        await this.cache?.setJson("fetch", cacheKey, {
          ok: true,
          url,
          finalUrl: out.url,
          status,
          contentType,
          bodyBase64: body.toString("base64"),
        });
        return out;
      } catch (err) {
        if (attempt >= this.maxRetries) {
          const out: HttpFetchResult = {
            ok: false,
            url,
            status: null,
            error: err instanceof Error ? err.message : String(err),
          };
          await this.cache?.setJson("fetch", cacheKey, {
            ok: false,
            url,
            status: null,
            error: out.error,
          });
          return out;
        }
        const backoffMs = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
        await sleep(backoffMs);
      }
    }

    return { ok: false, url, status: null, error: "unreachable" };
  }
}

export class PlaywrightRenderAdapter implements BrowserRenderAdapter {
  readonly name = "playwright";
  private readonly defaultTimeoutMs: number;
  private readonly userAgent: string | undefined;

  constructor(opts?: { defaultTimeoutMs?: number; userAgent?: string }) {
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 30_000;
    this.userAgent = opts?.userAgent;
  }

  async render(url: string, options?: BrowserRenderOptions): Promise<BrowserRenderResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const userAgent = options?.userAgent ?? this.userAgent;
    const captureHtml = options?.captureHtml === true;
    const captureTrace = options?.captureTrace === true;

    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext(userAgent ? { userAgent } : undefined);

        const tracePath = captureTrace
          ? path.join(os.tmpdir(), `openresearch-trace-${crypto.randomUUID()}.zip`)
          : undefined;

        if (captureTrace) {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        }

        const page = await context.newPage();
        await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
        const finalUrl = page.url();

        const extractedText = String(await page.evaluate(() => document.body?.innerText ?? ""));
        const title = await page.title().catch(() => null);
        const html = captureHtml ? await page.content() : undefined;

        let traceZip: Uint8Array | undefined;
        if (captureTrace && tracePath) {
          await context.tracing.stop({ path: tracePath });
          traceZip = await fs.readFile(tracePath);
          await fs.rm(tracePath, { force: true });
        }

        await context.close();
        const out: {
          ok: true;
          url: string;
          finalUrl: string;
          title: string | null;
          extractedText: string;
          html?: string;
          traceZip?: Uint8Array;
        } = { ok: true, url, finalUrl, title, extractedText };
        if (html !== undefined) out.html = html;
        if (traceZip !== undefined) out.traceZip = traceZip;
        return out;
      } finally {
        await browser.close();
      }
    } catch (err) {
      return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
