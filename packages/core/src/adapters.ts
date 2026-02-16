export type SearchQueryOptions = {
  maxResults?: number;
  language?: string;
  safeSearch?: boolean;
  recencyDays?: number;
};

export type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
};

export interface SearchAdapter {
  readonly name: string;
  search(query: string, options?: SearchQueryOptions): Promise<SearchResult[]>;
}

export type FetchOptions = {
  timeoutMs?: number;
  userAgent?: string;
  maxBytes?: number;
  headers?: Record<string, string>;
};

export type HttpFetchResult =
  | {
      ok: true;
      url: string;
      status: number;
      contentType: string | null;
      body: Uint8Array;
    }
  | {
      ok: false;
      url: string;
      status: number | null;
      error: string;
    };

export interface HttpFetchAdapter {
  readonly name: string;
  fetch(url: string, options?: FetchOptions): Promise<HttpFetchResult>;
}

export type BrowserRenderOptions = {
  timeoutMs?: number;
  userAgent?: string;
  captureHtml?: boolean;
  captureTrace?: boolean;
};

export type BrowserRenderResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      title: string | null;
      extractedText: string;
      html?: string;
      traceZip?: Uint8Array;
    }
  | {
      ok: false;
      url: string;
      error: string;
    };

export interface BrowserRenderAdapter {
  readonly name: string;
  render(url: string, options?: BrowserRenderOptions): Promise<BrowserRenderResult>;
}
