import crypto from "node:crypto";

import { loadConfig, runResearchPipeline } from "@openresearch/core";
import {
  BraveSearchAdapter,
  HttpFetchAdapterImpl,
  OpenRouterModelProvider,
  PlaywrightRenderAdapter,
  SearxngSearchAdapter,
} from "@openresearch/adapters";
import { DiskCache, FilesystemObjectStore, PostgresStore } from "@openresearch/storage";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseAdapterConfig(v: unknown): {
  searchBackend?: "searxng" | "brave";
  enablePlaywright?: boolean;
  debugCapture?: boolean;
} {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const sb =
    o.searchBackend === "brave" || o.searchBackend === "searxng" ? o.searchBackend : undefined;
  const enablePlaywright = typeof o.enablePlaywright === "boolean" ? o.enablePlaywright : undefined;
  const debugCapture = typeof o.debugCapture === "boolean" ? o.debugCapture : undefined;
  const out: {
    searchBackend?: "searxng" | "brave";
    enablePlaywright?: boolean;
    debugCapture?: boolean;
  } = {};
  if (sb) out.searchBackend = sb;
  if (enablePlaywright !== undefined) out.enablePlaywright = enablePlaywright;
  if (debugCapture !== undefined) out.debugCapture = debugCapture;
  return out;
}

export async function runWorker(opts?: { once?: boolean }): Promise<void> {
  const config = await loadConfig();

  const store = new PostgresStore({ databaseUrl: config.postgres.url });
  await store.migrate();

  const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
  const cache = new DiskCache({
    enabled: config.cache.enabled,
    rootPath: config.cache.rootPath,
    ttlMs: config.cache.ttlDays * 24 * 60 * 60 * 1000,
  });

  const searx = new SearxngSearchAdapter({
    baseUrl: config.search.searxng.baseUrl,
    userAgent: config.safety.userAgent,
    maxResultsPerQuery: config.search.maxResultsPerQuery,
    cache,
  });

  const brave = config.search.brave.apiKey
    ? new BraveSearchAdapter({
        apiKey: config.search.brave.apiKey,
        userAgent: config.safety.userAgent,
        maxResultsPerQuery: config.search.maxResultsPerQuery,
        cache,
      })
    : null;

  const httpFetch = new HttpFetchAdapterImpl({
    cache,
    userAgent: config.safety.userAgent,
    defaultMaxBytes: config.safety.maxContentBytes,
  });

  const browserRender = new PlaywrightRenderAdapter({ userAgent: config.safety.userAgent });

  const modelProvider = config.openRouter.apiKey
    ? new OpenRouterModelProvider(
        (() => {
          const out: {
            apiKey: string;
            baseUrl?: string;
            appName?: string;
            appUrl?: string;
            requestTimeoutMs?: number;
          } = {
            apiKey: config.openRouter.apiKey,
            baseUrl: config.openRouter.baseUrl,
            appName: config.openRouter.appName,
          };
          if (config.openRouter.appUrl) out.appUrl = config.openRouter.appUrl;
          if (config.openRouter.requestTimeoutMs !== undefined) {
            out.requestTimeoutMs = config.openRouter.requestTimeoutMs;
          }
          return out;
        })()
      )
    : undefined;

  const leaseOwner = `worker-${process.pid}-${crypto.randomUUID()}`;
  const active = new Set<Promise<void>>();

  const processJob = async (jobId: string): Promise<void> => {
    const job = await store.getJob(jobId);
    if (!job) return;

    await store.markJobRunning({ jobId: job.id, leaseOwner });
    const heartbeat = setInterval(() => {
      store
        .heartbeatJob({ jobId: job.id, leaseOwner, leaseMs: config.worker.leaseDurationMs })
        .catch(() => {});
    }, config.worker.heartbeatIntervalMs);

    try {
      const run = await store.getRun(job.run_id);
      if (!run) {
        await store.failJob(job.id);
        return;
      }

      const adapterCfg = parseAdapterConfig(run.adapter_config);
      const searchBackend = adapterCfg.searchBackend ?? config.search.backend;
      const search = searchBackend === "brave" && brave ? brave : searx;
      const enablePlaywright = adapterCfg.enablePlaywright ?? true;

      const debugCapture =
        adapterCfg.debugCapture === true
          ? { enabled: true, reason: "run.adapter_config.debugCapture" }
          : undefined;

      const services: Parameters<typeof runResearchPipeline>[0]["services"] = {
        store,
        objectStore,
        search,
        httpFetch,
      };
      if (enablePlaywright) services.browserRender = browserRender;
      if (modelProvider) services.modelProvider = modelProvider;

      const pipelineInput: Parameters<typeof runResearchPipeline>[0] = {
        runId: run.id,
        config,
        services,
        executionContext: {
          owner: "worker",
          jobId: job.id,
          startedAt: new Date().toISOString(),
        },
        shouldCancel: async () => {
          const j = await store.getJob(job.id);
          return j?.status === "canceled";
        },
      };
      if (debugCapture) pipelineInput.debugCapture = debugCapture;

      await runResearchPipeline(pipelineInput);

      const updatedRun = await store.getRun(run.id);
      if (updatedRun?.status === "completed") {
        await store.completeJob(job.id);
        return;
      }
      if (updatedRun?.status === "canceled") {
        await store.cancelJob(job.id, "run canceled");
        return;
      }

      // failed or unknown status
      const freshJob = await store.getJob(job.id);
      if (freshJob && freshJob.attempts < freshJob.max_attempts) {
        await store.requeueJob(job.id);
      } else {
        await store.failJob(job.id);
      }
    } finally {
      clearInterval(heartbeat);
    }
  };

  for (;;) {
    while (active.size < config.worker.maxConcurrentJobs) {
      const leased = await store.leaseNextJob({
        leaseOwner,
        leaseMs: config.worker.leaseDurationMs,
      });

      if (!leased) break;
      const p = processJob(leased.id).finally(() => active.delete(p));
      active.add(p);
    }

    if (opts?.once) break;

    if (active.size === 0) {
      await sleep(config.worker.pollIntervalMs);
      continue;
    }

    // Wait for at least one job to finish before attempting to lease more.
    try {
      await Promise.race(active);
    } catch {
      // errors are handled inside processJob
    }
  }

  await Promise.allSettled(Array.from(active));
  await store.close();
}
