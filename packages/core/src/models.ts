export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "high";
};

export type ChatCompletionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ChatCompletionResponse = {
  text: string;
  usage?: ChatCompletionUsage;
  raw?: unknown;
};

export interface ModelProvider {
  readonly name: string;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
