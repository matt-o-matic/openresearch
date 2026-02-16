import { Command } from "commander";

import { loadConfig, runOutputKey, runResearchPipeline } from "@openresearch/core";
import {
  BraveSearchAdapter,
  HttpFetchAdapterImpl,
  OpenRouterModelProvider,
  PlaywrightRenderAdapter,
  SearxngSearchAdapter,
} from "@openresearch/adapters";
import { buildApiServer } from "@openresearch/api";
import { runWorker } from "@openresearch/worker";
import { DiskCache, FilesystemObjectStore, PostgresStore } from "@openresearch/storage";

const program = new Command();

program.name("openresearch").description("OpenResearch CLI").version("0.1.0");

program
  .command("version")
  .description("Print version")
  .action(() => {
    console.log("0.1.0");
  });

program
  .command("migrate")
  .description("Run database migrations")
  .action(async () => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const { applied } = await store.migrate();
      if (applied.length === 0) {
        console.log("Migrations: up to date");
      } else {
        console.log(`Migrations applied: ${applied.join(", ")}`);
      }
    } finally {
      await store.close();
    }
  });

async function buildServices(config: Awaited<ReturnType<typeof loadConfig>>) {
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

  const search = config.search.backend === "brave" && brave ? brave : searx;

  const httpFetch = new HttpFetchAdapterImpl({
    cache,
    userAgent: config.safety.userAgent,
    defaultMaxBytes: config.safety.maxContentBytes,
  });

  const browserRender = new PlaywrightRenderAdapter({ userAgent: config.safety.userAgent });

  const modelProvider = config.openRouter.apiKey
    ? new OpenRouterModelProvider(
        (() => {
          const out: { apiKey: string; baseUrl?: string; appName?: string; appUrl?: string } = {
            apiKey: config.openRouter.apiKey,
            baseUrl: config.openRouter.baseUrl,
            appName: config.openRouter.appName,
          };
          if (config.openRouter.appUrl) out.appUrl = config.openRouter.appUrl;
          return out;
        })()
      )
    : undefined;

  const services: Parameters<typeof runResearchPipeline>[0]["services"] = {
    store,
    objectStore,
    search,
    httpFetch,
    browserRender,
  };
  if (modelProvider) services.modelProvider = modelProvider;

  return { store, objectStore, services };
}

type DbRunEvent = {
  id: string;
  created_at: string;
  level: "debug" | "info" | "warn" | "error";
  phase: string | null;
  event_type: string;
  message: string | null;
  data: Record<string, unknown> | null;
};

type DbRun = {
  id: string;
  status: "queued" | "running" | "failed" | "completed" | "canceled";
  phase: string | null;
  started_at: string | null;
  state: unknown;
};

type DbSource = {
  id: string;
  url: string;
  status: "pending" | "fetched" | "rendered" | "extracted" | "failed" | "skipped";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsed(startedAt: number): string {
  const totalMs = Math.max(0, Date.now() - startedAt);
  const totalSec = Math.floor(totalMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function eventLabel(event: DbRunEvent): string {
  if (event.message) return event.message;
  switch (event.event_type) {
    case "search_result_candidate":
      return `Candidate source: ${safeString(event.data?.url)}`;
    case "source_fetch_started":
      return `Fetching source: ${safeString(event.data?.url)}`;
    case "source_fetch_completed":
      return `Fetched source: ${safeString(event.data?.url)}`;
    case "source_fetch_failed":
      return `Fetch failed: ${safeString(event.data?.url)}`;
    case "source_extract_started":
      return `Extracting source: ${safeString(event.data?.url)}`;
    case "source_extract_completed":
      return `Extracted source: ${safeString(event.data?.url)}`;
    case "source_extract_failed":
      return `Extraction failed: ${safeString(event.data?.url)}`;
    case "search_query_started":
      return `Searching web for: ${safeString(event.data?.query)}`;
    case "search_query_completed":
      return `Search complete for: ${safeString(event.data?.query)}`;
    case "phase_started":
      return `Phase started: ${event.phase ?? "unknown"}`;
    case "phase_completed":
      return `Phase completed: ${event.phase ?? "unknown"}`;
    default:
      return `${event.event_type}`;
  }
}

function summarizeSources(sources: DbSource[]): string {
  const counts: Record<string, number> = {
    pending: 0,
    fetched: 0,
    rendered: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
  };
  for (const source of sources) {
    if (counts[source.status] !== undefined) counts[source.status]++;
  }
  return `pending=${counts.pending} fetched=${counts.fetched} rendered=${counts.rendered} extracted=${counts.extracted} failed=${counts.failed} skipped=${counts.skipped}`;
}

function summarizeCheckpoint(state: unknown): string {
  if (!state || typeof state !== "object") return "no checkpoints yet";
  const checkpoints = state as { counters?: Record<string, number> };
  const counters = checkpoints.counters ?? {};
  return `search=${String(counters.searchCalls ?? 0)}, fetch=${String(
    counters.fetches ?? 0
  )}, render=${String(counters.renders ?? 0)}, model=${String(counters.modelCalls ?? 0)}`;
}

async function streamRunProgress({
  runId,
  store,
  startedAt,
}: {
  runId: string;
  store: PostgresStore;
  startedAt: number;
}) {
  const seenEvents = new Set<string>();
  let lastPhase = "";
  let lastSourceSummary = "";
  let lastCheckpoint = "";
  let lastHeartbeat = 0;

  while (true) {
    const [run, sources, events] = await Promise.all([
      store.getRun(runId) as Promise<DbRun | null>,
      store.listSources(runId) as Promise<DbSource[]>,
      store.listRunEvents(runId, { limit: 40 }) as Promise<DbRunEvent[]>,
    ]);

    if (!run) return;
    const elapsed = formatElapsed(startedAt);
    const now = Date.now();
    const phase = run.phase ?? "queued";
    const sourceSummary = summarizeSources(sources);
    const checkpoint = summarizeCheckpoint(run.state);

    for (const event of [...events].reverse()) {
      if (seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      console.log(`[${elapsed}] ${eventLabel(event)}`);
    }

    if (phase !== lastPhase) {
      console.log(`[${elapsed}] Step: ${phase}`);
      lastPhase = phase;
    }

    if (sourceSummary !== lastSourceSummary) {
      console.log(`[${elapsed}] Sources: ${sourceSummary}`);
      lastSourceSummary = sourceSummary;
    }

    if (checkpoint !== lastCheckpoint) {
      console.log(`[${elapsed}] Counters: ${checkpoint}`);
      lastCheckpoint = checkpoint;
    }

    if (run.status !== "running" && run.status !== "queued") {
      console.log(`[${elapsed}] Final status: ${run.status}`);
      return;
    }

    if (now - lastHeartbeat > 3000) {
      const started = run.started_at ? ` started=${run.started_at}` : "";
      console.log(`[${elapsed}] Running${started} — ${phase} (${sourceSummary})`);
      lastHeartbeat = now;
    }

    await sleep(700);
  }
}

program
  .command("run")
  .description("Run the research pipeline locally (synchronous)")
  .argument("<prompt>", "Research prompt")
  .option("--debug-capture", "Enable Playwright debug capture (trace/html)", false)
  .action(async (prompt: string, opts: { debugCapture: boolean }) => {
    const config = await loadConfig();
    const { store, objectStore, services } = await buildServices(config);
    try {
      const users = await store.listUsers();
      const admin =
        users.find((u) => u.role === "admin" && u.status === "active") ??
        (await store.createUser({
          role: "admin",
          email: "local@openresearch",
          policy: config.policies.defaultUserPolicy,
        }));

      const run = await store.createRun({
        userId: admin.id,
        prompt,
        citationPolicy: config.citationPolicy,
        budgets: config.budgets,
        modelConfig: config.models,
        adapterConfig: {
          searchBackend: config.search.backend,
          enablePlaywright: true,
          thinkingMode: config.policies.qualityProfiles.full.thinkingMode,
          debugCapture: opts.debugCapture,
        },
        qualityTier: "full",
      });

      const pipelineInput: Parameters<typeof runResearchPipeline>[0] = {
        runId: run.id,
        config,
        services,
      };
      if (opts.debugCapture)
        pipelineInput.debugCapture = { enabled: true, reason: "cli --debug-capture" };

      const runStart = Date.now();
      await Promise.all([runResearchPipeline(pipelineInput), streamRunProgress({ runId: run.id, store, startedAt: runStart })]);

      const md = await objectStore.getText(runOutputKey(run.id));
      if (md) process.stdout.write(md);
      console.log(`\n\nRun: ${run.id}`);
    } finally {
      await store.close();
    }
  });

program
  .command("resume")
  .description("Resume a run from the last checkpoint")
  .argument("<runId>", "Run ID")
  .action(async (runId: string) => {
    const config = await loadConfig();
    const { store, services } = await buildServices(config);
    try {
      await runResearchPipeline({ runId, config, services });
      console.log(`Resumed: ${runId}`);
    } finally {
      await store.close();
    }
  });

program
  .command("explain")
  .description("Explain a run (status, events, artifacts)")
  .argument("<runId>", "Run ID")
  .action(async (runId: string) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    await store.migrate();
    const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
    try {
      const run = await store.getRun(runId);
      if (!run) {
        console.error("Run not found");
        process.exitCode = 1;
        return;
      }

      const events = await store.listRunEvents(runId, { limit: 25 });
      const sources = await store.listSources(runId);
      const artifacts = await objectStore.list(`runs/${runId}`);

      console.log(
        JSON.stringify(
          { run, sourcesCount: sources.length, recentEvents: events, artifacts },
          null,
          2
        )
      );
    } finally {
      await store.close();
    }
  });

program
  .command("serve")
  .description("Start the API server")
  .action(async () => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    await store.migrate();
    const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
    const app = await buildApiServer({ config, store, objectStore });
    await app.listen({ port: config.server.port, host: config.server.host });
  });

program
  .command("worker")
  .description("Run the job worker loop")
  .option("--once", "Process at most one lease cycle", false)
  .action(async (opts: { once: boolean }) => {
    await runWorker({ once: opts.once });
  });

const admin = program.command("admin").description("Admin utilities (local)");

admin
  .command("create-user")
  .description("Create a user")
  .option("--email <email>", "Email (optional)")
  .option("--role <role>", "Role: admin|user", "user")
  .action(async (opts: { email?: string; role: "admin" | "user" }) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const input: { email?: string; role: "admin" | "user" } = { role: opts.role };
      if (opts.email) input.email = opts.email;
      const user = await store.createUser(input);
      console.log(user.id);
    } finally {
      await store.close();
    }
  });

admin
  .command("create-key")
  .description("Create an API key for a user")
  .requiredOption("--user <userId>", "User ID")
  .option("--label <label>", "Key label")
  .action(async (opts: { user: string; label?: string }) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const input: { userId: string; label?: string } = { userId: opts.user };
      if (opts.label) input.label = opts.label;
      const { apiKey } = await store.createApiKey(input);
      console.log(apiKey);
    } finally {
      await store.close();
    }
  });

program.parseAsync(process.argv);
