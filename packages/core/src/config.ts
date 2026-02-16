import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CitationPolicySchema = z.enum(["balanced", "strict", "loose"]);
export type CitationPolicy = z.infer<typeof CitationPolicySchema>;

export const MonthlyThresholdSchema = z
  .object({
    costUsd: z.number().nonnegative().optional(),
    modelTokens: z.number().int().nonnegative().optional(),
    searchCalls: z.number().int().nonnegative().optional(),
    fetches: z.number().int().nonnegative().optional(),
    renders: z.number().int().nonnegative().optional(),
  })
  .default({});
export type MonthlyThreshold = z.infer<typeof MonthlyThresholdSchema>;

export const ThinkingModeSchema = z.enum(["low", "high"]).default("high");
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export const UserPolicySchema = z.object({
  requestsPerMinute: z.number().int().positive().default(60),
  maxConcurrentJobs: z.number().int().positive().default(1),
  downgradeThreshold: MonthlyThresholdSchema.default({
    costUsd: 5,
    modelTokens: 250_000,
    searchCalls: 250,
    fetches: 500,
    renders: 50,
  }),
  braveSearchQuota: z.number().int().nonnegative().default(0),
});
export type UserPolicy = z.infer<typeof UserPolicySchema>;

export const PhaseModelConfigSchema = z.object({
  planner: z.string().min(1).default("openai/gpt-4o-mini"),
  synthesizer: z.string().min(1).default("openai/gpt-4o-mini"),
  verifier: z.string().min(1).default("openai/gpt-4o-mini"),
  verifierStrong: z.string().min(1).default("openai/gpt-4o"),
});
export type PhaseModelConfig = z.infer<typeof PhaseModelConfigSchema>;

export const BudgetConfigSchema = z.object({
  maxRuntimeMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  maxSources: z.number().int().positive().default(10),
  maxFetches: z.number().int().nonnegative().default(20),
  maxBrowserRenders: z.number().int().nonnegative().default(5),
  fetchConcurrency: z.number().int().positive().default(4),
  extractConcurrency: z.number().int().positive().default(4),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const AgenticLoopConfigSchema = z.object({
  maxPlanPasses: z.number().int().positive().default(5),
  maxFollowUpTasksPerPass: z.number().int().positive().default(10),
});
export type AgenticLoopConfig = z.infer<typeof AgenticLoopConfigSchema>;

export const SynthesisConfigSchema = z.object({
  maxInputTokens: z.number().int().positive().default(1_000_000),
  maxOutputTokens: z.number().int().positive().default(500_000),
});
export type SynthesisConfig = z.infer<typeof SynthesisConfigSchema>;

export const QualityProfileSchema = z.object({
  name: z.string().optional(),
  searchBackend: z.enum(["searxng", "brave"]).default("searxng"),
  thinkingMode: ThinkingModeSchema,
  models: PhaseModelConfigSchema.default({}),
  budgets: BudgetConfigSchema.partial().default({}),
  agenticLoop: AgenticLoopConfigSchema.default({}),
  synthesis: SynthesisConfigSchema.default({}),
  enablePlaywright: z.boolean().default(true),
});
export type QualityProfile = z.infer<typeof QualityProfileSchema>;

export const OpenResearchConfigSchema = z.object({
  env: z.enum(["dev", "test", "prod"]).default("dev"),
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8787),
    })
    .default({}),
  worker: z
    .object({
      maxConcurrentJobs: z.number().int().positive().default(2),
      pollIntervalMs: z.number().int().positive().default(2_000),
      leaseDurationMs: z.number().int().positive().default(60_000),
      heartbeatIntervalMs: z.number().int().positive().default(15_000),
    })
    .default({}),
  postgres: z
    .object({
      url: z
        .string()
        .min(1)
        .default("postgres://openresearch:openresearch@localhost:5432/openresearch"),
    })
    .default({}),
  objectStore: z
    .object({
      type: z.literal("filesystem").default("filesystem"),
      rootPath: z.string().min(1).default(path.join(".openresearch", "object-store")),
    })
    .default({}),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      rootPath: z.string().min(1).default(path.join(".openresearch", "cache")),
      ttlDays: z.number().int().positive().default(7),
    })
    .default({}),
  debug: z
    .object({
      traceTtlDays: z.number().int().positive().default(7),
    })
    .default({}),
  openRouter: z
    .object({
      apiKey: z.string().min(1).optional(),
      baseUrl: z.string().min(1).default("https://openrouter.ai/api/v1"),
      appName: z.string().min(1).default("openresearch"),
      appUrl: z.string().min(1).optional(),
    })
    .default({}),
  search: z
    .object({
      backend: z.enum(["searxng", "brave"]).default("searxng"),
      maxResultsPerQuery: z.number().int().positive().default(10),
      searxng: z
        .object({
          baseUrl: z.string().min(1).default("http://localhost:8080"),
        })
        .default({}),
      brave: z
        .object({
          apiKey: z.string().min(1).optional(),
        })
        .default({}),
    })
    .default({}),
  models: PhaseModelConfigSchema.default({}),
  budgets: BudgetConfigSchema.default({}),
  citationPolicy: CitationPolicySchema.default("balanced"),
  policies: z
    .object({
      defaultUserPolicy: UserPolicySchema.default({}),
      qualityProfiles: z
        .object({
          full: QualityProfileSchema.default({
            name: "full",
            searchBackend: "searxng",
            enablePlaywright: true,
            thinkingMode: "high",
            models: {
              planner: "openai/gpt-4o-mini",
              synthesizer: "openai/gpt-4o-mini",
              verifier: "openai/gpt-4o-mini",
              verifierStrong: "openai/gpt-4o",
            },
            budgets: {
              maxRuntimeMs: 5 * 60_000,
              maxSources: 10,
              maxFetches: 20,
              maxBrowserRenders: 5,
              fetchConcurrency: 4,
              extractConcurrency: 4,
            },
            agenticLoop: {
              maxPlanPasses: 5,
              maxFollowUpTasksPerPass: 10,
            },
            synthesis: {
              maxInputTokens: 1_000_000,
              maxOutputTokens: 500_000,
            },
          }),
          degraded: QualityProfileSchema.default({
            name: "degraded",
            searchBackend: "searxng",
            enablePlaywright: true,
            thinkingMode: "low",
            models: {
              planner: "openai/gpt-4o-mini",
              synthesizer: "openai/gpt-4o-mini",
              verifier: "openai/gpt-4o-mini",
              verifierStrong: "openai/gpt-4o-mini",
            },
            budgets: {
              maxRuntimeMs: 3 * 60_000,
              maxSources: 5,
              maxFetches: 10,
              maxBrowserRenders: 2,
              fetchConcurrency: 2,
              extractConcurrency: 2,
            },
            agenticLoop: {
              maxPlanPasses: 5,
              maxFollowUpTasksPerPass: 10,
            },
            synthesis: {
              maxInputTokens: 1_000_000,
              maxOutputTokens: 500_000,
            },
          }),
        })
        .default({}),
    })
    .default({}),
  safety: z
    .object({
      allowedDomains: z.array(z.string()).default([]),
      deniedDomains: z.array(z.string()).default([]),
      userAgent: z.string().min(1).default("openresearch/0.1.0"),
      maxContentBytes: z.number().int().positive().default(2_000_000),
    })
    .default({}),
});

export type OpenResearchConfig = z.infer<typeof OpenResearchConfigSchema>;

function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^env:([A-Z0-9_]+)$/);
    const key = m?.[1];
    if (key) return process.env[key];
    return value;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const resolved = resolveEnvRefs(item);
      if (resolved !== undefined) out.push(resolved);
    }
    return out;
  }

  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const resolved = resolveEnvRefs(v);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== "object" || base === null) return override ?? base;
  if (typeof override !== "object" || override === null) return base;

  const baseObj = base as Record<string, unknown>;
  const overrideObj = override as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseObj };

  for (const [key, value] of Object.entries(overrideObj)) {
    out[key] = key in baseObj ? deepMerge(baseObj[key], value) : value;
  }
  return out;
}

export async function loadConfig(opts?: { cwd?: string }): Promise<OpenResearchConfig> {
  const cwd = opts?.cwd ?? process.cwd();

  const configPath = process.env.OPENRESEARCH_CONFIG ?? path.join(cwd, "openresearch.config.json");
  const fileConfig = existsSync(configPath)
    ? resolveEnvRefs(JSON.parse(await readFile(configPath, "utf8")))
    : ({} as unknown);

  const envOverrides: unknown = {
    env: process.env.NODE_ENV,
    server: {
      host: process.env.HOST,
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
    },
    postgres: {
      url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    },
    objectStore: {
      rootPath: process.env.OPENRESEARCH_OBJECT_STORE_PATH,
    },
    cache: {
      enabled: process.env.OPENRESEARCH_CACHE_ENABLED
        ? process.env.OPENRESEARCH_CACHE_ENABLED === "true"
        : undefined,
      rootPath: process.env.OPENRESEARCH_CACHE_PATH,
      ttlDays: process.env.OPENRESEARCH_CACHE_TTL_DAYS
        ? Number(process.env.OPENRESEARCH_CACHE_TTL_DAYS)
        : undefined,
    },
    openRouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL,
      appName: process.env.OPENROUTER_APP_NAME,
      appUrl: process.env.OPENROUTER_APP_URL,
    },
    search: {
      backend: process.env.OPENRESEARCH_SEARCH_BACKEND,
      searxng: { baseUrl: process.env.SEARXNG_URL },
      brave: { apiKey: process.env.BRAVE_API_KEY },
    },
  };

  const merged = deepMerge(fileConfig, envOverrides);
  return OpenResearchConfigSchema.parse(merged);
}
