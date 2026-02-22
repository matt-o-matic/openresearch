import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
} from "@openresearch/core";

type OpenRouterChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  error?: { message?: string };
};

export class OpenRouterModelProvider implements ModelProvider {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly appName: string;
  private readonly appUrl: string | undefined;
  private readonly requestTimeoutMs: number;

  static readonly EMPTY_RESPONSE_MARKER = "EMPTY_MODEL_RESPONSE";
  static readonly TIMEOUT_RESPONSE_MARKER = "MODEL_CALL_TIMEOUT";

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    appName?: string;
    appUrl?: string;
    requestTimeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.appName = opts.appName ?? "openresearch";
    this.appUrl = opts.appUrl;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      reasoning_effort: req.reasoningEffort,
    };

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      "x-title": this.appName,
    };
    if (this.appUrl) headers["http-referer"] = this.appUrl;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `${OpenRouterModelProvider.TIMEOUT_RESPONSE_MARKER}: Request timed out after ${this.requestTimeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const json = (await res.json().catch(() => ({}))) as OpenRouterChatResponse;
    if (!res.ok) {
      const msg = json.error?.message ?? `OpenRouter error: ${res.status} ${res.statusText}`;
      throw new Error(msg);
    }

    const text = typeof json.choices?.[0]?.message?.content === "string"
      ? json.choices[0].message.content
      : "";
    if (!text.trim()) {
      throw new Error(`${OpenRouterModelProvider.EMPTY_RESPONSE_MARKER}: Empty model response`);
    }

    let usage: ChatCompletionResponse["usage"] | undefined;
    if (json.usage) {
      const u: NonNullable<ChatCompletionResponse["usage"]> = {};
      if (json.usage.prompt_tokens !== undefined) u.inputTokens = json.usage.prompt_tokens;
      if (json.usage.completion_tokens !== undefined) u.outputTokens = json.usage.completion_tokens;
      if (json.usage.total_tokens !== undefined) u.totalTokens = json.usage.total_tokens;
      if (json.usage.cost !== undefined) u.costUsd = json.usage.cost;
      if (Object.keys(u).length > 0) usage = u;
    }

    const out: ChatCompletionResponse = { text, raw: json };
    if (usage) out.usage = usage;
    return out;
  }
}
