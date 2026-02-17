import type { OpenResearchConfig, UsageSnapshot, UserPolicy } from "@openresearch/core";
import { selectQualityForUser, UserPolicySchema } from "@openresearch/core";
import type {
  FilesystemObjectStore,
  ObjectStoreListItem,
  PostgresStore,
} from "@openresearch/storage";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

type Authed = {
  user: {
    id: string;
    role: "admin" | "user";
    policy: UserPolicy;
  };
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: Authed;
  }
}

function mergeUserPolicy(defaultPolicy: UserPolicy, fromDb: unknown): UserPolicy {
  const parsed = UserPolicySchema.partial().safeParse(fromDb);
  const patch = parsed.success ? parsed.data : {};
  const out: UserPolicy = {
    ...defaultPolicy,
    downgradeThreshold: { ...defaultPolicy.downgradeThreshold },
  };

  if (patch.requestsPerMinute !== undefined) out.requestsPerMinute = patch.requestsPerMinute;
  if (patch.maxConcurrentJobs !== undefined) out.maxConcurrentJobs = patch.maxConcurrentJobs;
  if (patch.braveSearchQuota !== undefined) out.braveSearchQuota = patch.braveSearchQuota;
  if (patch.downgradeThreshold)
    out.downgradeThreshold = { ...out.downgradeThreshold, ...patch.downgradeThreshold };

  return out;
}

function usageSnapshotFromRow(row: {
  search_calls: number;
  fetches: number;
  renders: number;
  model_tokens_in: number;
  model_tokens_out: number;
  cost_usd: string;
}): UsageSnapshot {
  return {
    searchCalls: row.search_calls,
    fetches: row.fetches,
    renders: row.renders,
    modelTokensIn: row.model_tokens_in,
    modelTokensOut: row.model_tokens_out,
    costUsd: Number(row.cost_usd),
  };
}

function isAdmin(req: { auth?: Authed }): boolean {
  return req.auth?.user.role === "admin";
}

function filterArtifacts(
  items: ObjectStoreListItem[],
  runId: string,
  admin: boolean
): ObjectStoreListItem[] {
  if (admin) return items;
  const prefix = `runs/${runId}/debug/`;
  return items.filter((i) => !i.key.startsWith(prefix));
}

function rateLimiter() {
  type Bucket = { tokens: number; updatedAtMs: number; capacity: number };
  const buckets = new Map<string, Bucket>();

  const take = (userId: string, capacity: number): boolean => {
    const now = Date.now();
    const b = buckets.get(userId) ?? { tokens: capacity, updatedAtMs: now, capacity };
    b.capacity = capacity;

    const refillPerMs = capacity / 60_000;
    const elapsed = Math.max(0, now - b.updatedAtMs);
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
    b.updatedAtMs = now;

    if (b.tokens < 1) {
      buckets.set(userId, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(userId, b);
    return true;
  };

  return { take };
}

export async function buildApiServer(input: {
  config: OpenResearchConfig;
  store: PostgresStore;
  objectStore: FilesystemObjectStore;
}) {
  const app = Fastify({ logger: true });
  const limiter = rateLimiter();

  const RunIdParamsSchema = z.object({ runId: z.string().uuid() });
  const JobIdParamsSchema = z.object({ jobId: z.string().uuid() });
  const UserIdParamsSchema = z.object({ userId: z.string().uuid() });
  const KeyIdParamsSchema = z.object({ keyId: z.string().uuid() });

  app.get("/health", async () => ({ ok: true }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!token) return reply.code(401).send({ error: "missing_api_key" });

    const authed = await input.store.authenticateApiKey(token);
    if (!authed) return reply.code(401).send({ error: "invalid_api_key" });

    const userPolicy = mergeUserPolicy(input.config.policies.defaultUserPolicy, authed.user.policy);
    req.auth = { user: { id: authed.user.id, role: authed.user.role, policy: userPolicy } };

    const ok = limiter.take(req.auth.user.id, req.auth.user.policy.requestsPerMinute);
    if (!ok) return reply.code(429).send({ error: "rate_limited" });
  });

  const CreateRunBodySchema = z.object({
    prompt: z.string().min(1),
    debugCapture: z.boolean().optional(),
    citationPolicy: z.enum(["balanced", "strict", "loose"]).optional(),
    researchLoop: z.boolean().optional(),
  });

  app.post("/runs", async (req, reply) => {
    const auth = req.auth!;
    const body = CreateRunBodySchema.parse(req.body);

    const usageRow = await input.store.getUsageMonth(auth.user.id);
    const usage = usageSnapshotFromRow(usageRow);

    const { tier, profile, effectiveConfig } = selectQualityForUser({
      config: input.config,
      userPolicy: auth.user.policy,
      usage,
    });

    const run = await input.store.createRun({
      userId: auth.user.id,
      prompt: body.prompt,
      citationPolicy: body.citationPolicy ?? effectiveConfig.citationPolicy,
      budgets: effectiveConfig.budgets,
      modelConfig: effectiveConfig.models,
      adapterConfig: {
        searchBackend: profile.searchBackend,
        thinkingMode: profile.thinkingMode,
        enablePlaywright: profile.enablePlaywright,
        debugCapture: body.debugCapture === true,
        agenticLoop: profile.agenticLoop,
        synthesis: profile.synthesis,
        researchLoop: {
          ...profile.researchLoop,
          enabled: body.researchLoop ?? profile.researchLoop.enabled,
        },
      },
      qualityTier: tier,
    });

    const job = await input.store.createJob({ runId: run.id, userId: auth.user.id, priority: 0 });
    await input.store.addRunEvent({
      runId: run.id,
      level: "info",
      eventType: "job_enqueued",
      message: "Job enqueued",
      data: { jobId: job.id },
    });

    return reply.code(201).send({ runId: run.id, jobId: job.id });
  });

  app.get("/runs/:runId", async (req, reply) => {
    const auth = req.auth!;
    const runId = RunIdParamsSchema.parse(req.params).runId;
    const run = await input.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (!isAdmin(req) && run.user_id !== auth.user.id)
      return reply.code(403).send({ error: "forbidden" });

    const events = await input.store.listRunEvents(runId, { limit: 50 });
    const sources = await input.store.listSources(runId);
    const counts = {
      total: sources.length,
      extracted: sources.filter((s) => s.status === "extracted").length,
      failed: sources.filter((s) => s.status === "failed").length,
    };

    return reply.send({ run, counts, events });
  });

  app.get("/runs/:runId/output", async (req, reply) => {
    const auth = req.auth!;
    const runId = RunIdParamsSchema.parse(req.params).runId;
    const run = await input.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (!isAdmin(req) && run.user_id !== auth.user.id)
      return reply.code(403).send({ error: "forbidden" });

    const key = `runs/${runId}/output.md`;
    const md = await input.objectStore.getText(key);
    if (!md) return reply.code(404).send({ error: "not_ready" });

    reply.header("content-type", "text/markdown; charset=utf-8");
    return reply.send(md);
  });

  app.get("/runs/:runId/artifacts", async (req, reply) => {
    const auth = req.auth!;
    const runId = RunIdParamsSchema.parse(req.params).runId;
    const run = await input.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (!isAdmin(req) && run.user_id !== auth.user.id)
      return reply.code(403).send({ error: "forbidden" });

    const items = await input.objectStore.list(`runs/${runId}`);
    return reply.send({ artifacts: filterArtifacts(items, runId, isAdmin(req)) });
  });

  app.get("/runs/:runId/artifacts/download", async (req, reply) => {
    const auth = req.auth!;
    const runId = RunIdParamsSchema.parse(req.params).runId;
    const run = await input.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (!isAdmin(req) && run.user_id !== auth.user.id)
      return reply.code(403).send({ error: "forbidden" });

    const key = z
      .object({ key: z.string().min(1) })
      .parse(req.query as Record<string, unknown>).key;
    if (!key) return reply.code(400).send({ error: "missing_key" });
    if (!key.startsWith(`runs/${runId}/`)) return reply.code(400).send({ error: "invalid_key" });
    if (!isAdmin(req) && key.startsWith(`runs/${runId}/debug/`))
      return reply.code(403).send({ error: "forbidden" });

    const meta = await input.objectStore.stat(key);
    if (!meta) return reply.code(404).send({ error: "not_found" });

    reply.header("content-length", String(meta.bytes));
    return reply.send(input.objectStore.createReadStream(key));
  });

  app.post("/runs/:runId/cancel", async (req, reply) => {
    const auth = req.auth!;
    const runId = RunIdParamsSchema.parse(req.params).runId;
    const run = await input.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (!isAdmin(req) && run.user_id !== auth.user.id)
      return reply.code(403).send({ error: "forbidden" });

    const job = await input.store.getJobByRunId(runId);
    if (job) await input.store.cancelJob(job.id, "user requested cancel");
    await input.store.updateRun({ runId, status: "canceled", finishedAt: new Date() });
    await input.store.addRunEvent({ runId, level: "info", eventType: "cancel_requested" });

    return reply.send({ ok: true });
  });

  // ---- Admin ----

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: "admin_only" });
  };

  app.get("/admin/jobs", { preHandler: requireAdmin }, async (_req, reply) => {
    const jobs = await input.store.listJobs({ limit: 500 });
    return reply.send({ jobs });
  });

  app.post("/admin/jobs/:jobId/cancel", { preHandler: requireAdmin }, async (req, reply) => {
    const jobId = JobIdParamsSchema.parse(req.params).jobId;
    await input.store.cancelJob(jobId, "admin cancel");
    return reply.send({ ok: true });
  });

  const PriorityBodySchema = z.object({ priority: z.number().int() });
  app.post("/admin/jobs/:jobId/priority", { preHandler: requireAdmin }, async (req, reply) => {
    const jobId = JobIdParamsSchema.parse(req.params).jobId;
    const body = PriorityBodySchema.parse(req.body);
    await input.store.reprioritizeJob(jobId, body.priority);
    return reply.send({ ok: true });
  });

  app.get("/admin/users", { preHandler: requireAdmin }, async (_req, reply) => {
    const users = await input.store.listUsers();
    return reply.send({ users });
  });

  const CreateUserBodySchema = z.object({
    email: z.string().email().optional(),
    role: z.enum(["admin", "user"]).default("user"),
  });
  app.post("/admin/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateUserBodySchema.parse(req.body);
    const createInput: { email?: string; role: "admin" | "user"; policy: UserPolicy } = {
      role: body.role,
      policy: input.config.policies.defaultUserPolicy,
    };
    if (body.email) createInput.email = body.email;
    const user = await input.store.createUser(createInput);
    return reply.code(201).send({ user });
  });

  app.post("/admin/users/:userId/disable", { preHandler: requireAdmin }, async (req, reply) => {
    const userId = UserIdParamsSchema.parse(req.params).userId;
    await input.store.disableUser(userId);
    return reply.send({ ok: true });
  });

  app.post("/admin/users/:userId/policy", { preHandler: requireAdmin }, async (req, reply) => {
    const userId = UserIdParamsSchema.parse(req.params).userId;
    const next = UserPolicySchema.parse(req.body);
    await input.store.setUserPolicy(userId, next);
    return reply.send({ ok: true });
  });

  app.post("/admin/users/:userId/keys", { preHandler: requireAdmin }, async (req, reply) => {
    const userId = UserIdParamsSchema.parse(req.params).userId;
    const label = z
      .object({ label: z.string().min(1).optional() })
      .parse(req.body as Record<string, unknown>).label;
    const { apiKey, row } = await input.store.createApiKey({ userId, ...(label ? { label } : {}) });
    return reply.code(201).send({ apiKey, key: row });
  });

  app.post("/admin/keys/:keyId/revoke", { preHandler: requireAdmin }, async (req, reply) => {
    const keyId = KeyIdParamsSchema.parse(req.params).keyId;
    await input.store.revokeApiKey(keyId);
    return reply.send({ ok: true });
  });

  app.get("/admin/users/:userId/usage", { preHandler: requireAdmin }, async (req, reply) => {
    const userId = UserIdParamsSchema.parse(req.params).userId;
    const month = z
      .object({ month: z.string().min(1).optional() })
      .parse(req.query as Record<string, unknown>).month;
    const usage = await input.store.getUsageMonth(userId, month);
    return reply.send({ usage });
  });

  return app;
}
