import type { OpenResearchConfig, QualityProfile, UserPolicy } from "./config.js";

export type UsageSnapshot = {
  searchCalls: number;
  fetches: number;
  renders: number;
  modelTokensIn: number;
  modelTokensOut: number;
  costUsd: number;
};

export type QualityTier = "full" | "degraded";

function shouldDowngrade(policy: UserPolicy, usage: UsageSnapshot): boolean {
  const t = policy.downgradeThreshold;
  if (t.costUsd !== undefined && usage.costUsd >= t.costUsd) return true;
  if (t.modelTokens !== undefined && usage.modelTokensIn + usage.modelTokensOut >= t.modelTokens)
    return true;
  if (t.searchCalls !== undefined && usage.searchCalls >= t.searchCalls) return true;
  if (t.fetches !== undefined && usage.fetches >= t.fetches) return true;
  if (t.renders !== undefined && usage.renders >= t.renders) return true;
  return false;
}

function applyProfile(config: OpenResearchConfig, profile: QualityProfile): OpenResearchConfig {
  const mergedBudgets = { ...config.budgets, ...profile.budgets } as OpenResearchConfig["budgets"];
  return {
    ...config,
    budgets: mergedBudgets,
    models: profile.models,
    search: { ...config.search, backend: profile.searchBackend },
  };
}

export function selectQualityForUser(input: {
  config: OpenResearchConfig;
  userPolicy: UserPolicy;
  usage: UsageSnapshot;
}): { tier: QualityTier; profile: QualityProfile; effectiveConfig: OpenResearchConfig } {
  const { config, userPolicy, usage } = input;
  const tier: QualityTier = shouldDowngrade(userPolicy, usage) ? "degraded" : "full";
  const baseProfile =
    tier === "full"
      ? config.policies.qualityProfiles.full
      : config.policies.qualityProfiles.degraded;

  // Brave quota enforcement: if quota is exceeded, force SearXNG regardless of configured backend.
  const profile =
    baseProfile.searchBackend === "brave" &&
    userPolicy.braveSearchQuota > 0 &&
    usage.searchCalls >= userPolicy.braveSearchQuota
      ? { ...baseProfile, searchBackend: "searxng" as const }
      : baseProfile;

  return { tier, profile, effectiveConfig: applyProfile(config, profile) };
}
