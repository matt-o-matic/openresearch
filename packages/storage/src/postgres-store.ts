import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import type { UserPolicy } from "@openresearch/core";

import { createPool } from "./db.js";
import { runMigrations } from "./migrate.js";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";

export type DbUser = {
  id: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  policy: UserPolicy;
  created_at: string;
  disabled_at: string | null;
};

export type DbApiKey = {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type UserUsageMonthly = {
  user_id: string;
  month: string;
  search_calls: number;
  fetches: number;
  renders: number;
  model_tokens_in: number;
  model_tokens_out: number;
  cost_usd: string;
  updated_at: string;
};

export type RunStatus = "queued" | "running" | "failed" | "completed" | "canceled";
export type JobStatus = "queued" | "leased" | "running" | "failed" | "completed" | "canceled";
export type EventLevel = "debug" | "info" | "warn" | "error";

export type DbRun = {
  id: string;
  user_id: string;
  prompt: string;
  status: RunStatus;
  phase: string | null;
  template: string;
  citation_policy: string;
  budgets: unknown;
  model_config: unknown;
  adapter_config: unknown;
  quality_tier: string;
  plan: unknown | null;
  state: unknown | null;
  error: unknown | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type DbJob = {
  id: string;
  run_id: string;
  user_id: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
};

export type DbRunEvent = {
  id: string;
  run_id: string;
  created_at: string;
  level: EventLevel;
  phase: string | null;
  event_type: string;
  message: string | null;
  data: unknown;
};

export type SourceStatus = "pending" | "fetched" | "rendered" | "extracted" | "failed" | "skipped";
export type DbSource = {
  id: string;
  run_id: string;
  url: string;
  final_url: string | null;
  status: SourceStatus;
  http_status: number | null;
  content_type: string | null;
  content_hash: string | null;
  fetched_at: string | null;
  title: string | null;
  publisher: string | null;
  authors: string[] | null;
  published_at: string | null;
  raw_body_key: string | null;
  render_text_key: string | null;
  render_html_key: string | null;
  render_trace_key: string | null;
  extract_key: string | null;
  error: unknown | null;
  created_at: string;
  updated_at: string;
};

export type DbModelCall = {
  id: string;
  run_id: string;
  phase: string;
  model_id: string;
  created_at: string;
  params: unknown;
  prompt_version: string | null;
  input_hash: string | null;
  output_hash: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string | null;
  request_key: string | null;
  response_key: string | null;
};

export type DbCitation = {
  id: string;
  run_id: string;
  claim_id: string;
  source_id: string;
  quote_start: number | null;
  quote_end: number | null;
  created_at: string;
};

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function monthStartUtc(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

export class PostgresStore {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
  private readonly pool;

  constructor(opts: { databaseUrl: string; migrationsDir?: string }) {
    this.databaseUrl = opts.databaseUrl;
    this.migrationsDir =
      opts.migrationsDir ?? fileURLToPath(new URL("../migrations", import.meta.url));
    this.pool = createPool(this.databaseUrl);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<{ applied: string[] }> {
    const { applied } = await runMigrations({ pool: this.pool, migrationsDir: this.migrationsDir });
    return { applied };
  }

  // --- Users ---

  async createUser(input: {
    email?: string;
    role: UserRole;
    policy?: UserPolicy;
  }): Promise<DbUser> {
    const res = await this.pool.query<DbUser>(
      `
        INSERT INTO users (email, role, status, policy)
        VALUES ($1, $2, 'active', $3)
        RETURNING *
      `,
      [input.email ?? null, input.role, input.policy ?? {}]
    );
    return res.rows[0]!;
  }

  async getUser(userId: string): Promise<DbUser | null> {
    const res = await this.pool.query<DbUser>("SELECT * FROM users WHERE id = $1", [userId]);
    return res.rows[0] ?? null;
  }

  async listUsers(): Promise<DbUser[]> {
    const res = await this.pool.query<DbUser>("SELECT * FROM users ORDER BY created_at ASC");
    return res.rows;
  }

  async disableUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`,
      [userId]
    );
  }

  async setUserPolicy(userId: string, policy: UserPolicy): Promise<void> {
    await this.pool.query(`UPDATE users SET policy = $2 WHERE id = $1`, [userId, policy]);
  }

  // --- API Keys ---

  async createApiKey(input: {
    userId: string;
    label?: string;
  }): Promise<{ apiKey: string; row: DbApiKey }> {
    const secret = crypto.randomBytes(32).toString("base64url");
    const apiKey = `orpk_${secret}`;
    const keyPrefix = secret.slice(0, 8);
    const keyHash = sha256Hex(apiKey);

    const res = await this.pool.query<DbApiKey>(
      `
        INSERT INTO api_keys (user_id, key_prefix, key_hash, label)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [input.userId, keyPrefix, keyHash, input.label ?? null]
    );

    return { apiKey, row: res.rows[0]! };
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.pool.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [keyId]);
  }

  async authenticateApiKey(apiKey: string): Promise<{ user: DbUser; apiKey: DbApiKey } | null> {
    if (!apiKey.startsWith("orpk_")) return null;
    const secret = apiKey.slice("orpk_".length);
    if (secret.length < 16) return null;

    const keyPrefix = secret.slice(0, 8);
    const candidates = await this.pool.query<
      DbApiKey & {
        user_role: UserRole;
        user_status: UserStatus;
        user_policy: UserPolicy;
        user_email: string | null;
        user_created_at: string;
        user_disabled_at: string | null;
      }
    >(
      `
        SELECT
          k.*,
          u.role AS user_role,
          u.status AS user_status,
          u.policy AS user_policy,
          u.email AS user_email,
          u.created_at AS user_created_at,
          u.disabled_at AS user_disabled_at
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
        WHERE k.key_prefix = $1
          AND k.revoked_at IS NULL
      `,
      [keyPrefix]
    );

    const incomingHash = sha256Hex(apiKey);
    for (const row of candidates.rows) {
      const a = Buffer.from(row.key_hash, "hex");
      const b = Buffer.from(incomingHash, "hex");
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) continue;
      if (row.user_status !== "active") return null;

      await this.pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);

      const user: DbUser = {
        id: row.user_id,
        email: row.user_email,
        role: row.user_role,
        status: row.user_status,
        policy: row.user_policy,
        created_at: row.user_created_at,
        disabled_at: row.user_disabled_at,
      };
      return { user, apiKey: row };
    }

    return null;
  }

  // --- Usage ---

  async getUsageMonth(userId: string, month?: string): Promise<UserUsageMonthly> {
    const monthKey = month ?? monthStartUtc(new Date());
    const res = await this.pool.query<UserUsageMonthly>(
      `SELECT * FROM user_usage_monthly WHERE user_id = $1 AND month = $2`,
      [userId, monthKey]
    );
    if (res.rows[0]) return res.rows[0];
    return {
      user_id: userId,
      month: monthKey,
      search_calls: 0,
      fetches: 0,
      renders: 0,
      model_tokens_in: 0,
      model_tokens_out: 0,
      cost_usd: "0",
      updated_at: new Date(0).toISOString(),
    };
  }

  async addUsageDelta(input: {
    userId: string;
    month?: string;
    searchCalls?: number;
    fetches?: number;
    renders?: number;
    modelTokensIn?: number;
    modelTokensOut?: number;
    costUsd?: number;
  }): Promise<void> {
    const monthKey = input.month ?? monthStartUtc(new Date());
    await this.pool.query(
      `
        INSERT INTO user_usage_monthly (
          user_id, month, search_calls, fetches, renders, model_tokens_in, model_tokens_out, cost_usd
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id, month) DO UPDATE SET
          search_calls = user_usage_monthly.search_calls + EXCLUDED.search_calls,
          fetches = user_usage_monthly.fetches + EXCLUDED.fetches,
          renders = user_usage_monthly.renders + EXCLUDED.renders,
          model_tokens_in = user_usage_monthly.model_tokens_in + EXCLUDED.model_tokens_in,
          model_tokens_out = user_usage_monthly.model_tokens_out + EXCLUDED.model_tokens_out,
          cost_usd = user_usage_monthly.cost_usd + EXCLUDED.cost_usd,
          updated_at = now()
      `,
      [
        input.userId,
        monthKey,
        input.searchCalls ?? 0,
        input.fetches ?? 0,
        input.renders ?? 0,
        input.modelTokensIn ?? 0,
        input.modelTokensOut ?? 0,
        input.costUsd ?? 0,
      ]
    );
  }

  // --- Runs / jobs / logs ---

  async createRun(input: {
    userId: string;
    prompt: string;
    template?: string;
    citationPolicy?: string;
    budgets?: unknown;
    modelConfig?: unknown;
    adapterConfig?: unknown;
    qualityTier?: string;
  }): Promise<DbRun> {
    const res = await this.pool.query<DbRun>(
      `
        INSERT INTO runs (
          user_id, prompt, status, template, citation_policy, budgets, model_config, adapter_config, quality_tier
        )
        VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        input.userId,
        input.prompt,
        input.template ?? "research-memo",
        input.citationPolicy ?? "balanced",
        input.budgets ?? {},
        input.modelConfig ?? {},
        input.adapterConfig ?? {},
        input.qualityTier ?? "full",
      ]
    );
    return res.rows[0]!;
  }

  async getRun(runId: string): Promise<DbRun | null> {
    const res = await this.pool.query<DbRun>("SELECT * FROM runs WHERE id = $1", [runId]);
    return res.rows[0] ?? null;
  }

  async updateRun(input: {
    runId: string;
    status?: RunStatus;
    phase?: string | null;
    plan?: unknown | null;
    state?: unknown | null;
    error?: unknown | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  }): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [input.runId];

    const push = (sql: string, value: unknown) => {
      fields.push(sql.replace("$v", `$${values.length + 1}`));
      values.push(value);
    };

    if (input.status !== undefined) push("status = $v", input.status);
    if (input.phase !== undefined) push("phase = $v", input.phase);
    if (input.plan !== undefined) push("plan = $v", input.plan);
    if (input.state !== undefined) push("state = $v", input.state);
    if (input.error !== undefined) push("error = $v", input.error);
    if (input.startedAt !== undefined) push("started_at = $v", input.startedAt);
    if (input.finishedAt !== undefined) push("finished_at = $v", input.finishedAt);

    if (fields.length === 0) return;
    await this.pool.query(`UPDATE runs SET ${fields.join(", ")} WHERE id = $1`, values);
  }

  async addRunEvent(input: {
    runId: string;
    level: EventLevel;
    phase?: string;
    eventType: string;
    message?: string;
    data?: unknown;
  }): Promise<DbRunEvent> {
    const res = await this.pool.query<DbRunEvent>(
      `
        INSERT INTO run_events (run_id, level, phase, event_type, message, data)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        input.runId,
        input.level,
        input.phase ?? null,
        input.eventType,
        input.message ?? null,
        input.data ?? {},
      ]
    );
    return res.rows[0]!;
  }

  async listRunEvents(runId: string, opts?: { limit?: number }): Promise<DbRunEvent[]> {
    const limit = opts?.limit ?? 50;
    const res = await this.pool.query<DbRunEvent>(
      `SELECT * FROM run_events WHERE run_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [runId, limit]
    );
    return res.rows;
  }

  async createJob(input: { runId: string; userId: string; priority?: number }): Promise<DbJob> {
    const res = await this.pool.query<DbJob>(
      `
        INSERT INTO jobs (run_id, user_id, status, priority)
        VALUES ($1, $2, 'queued', $3)
        RETURNING *
      `,
      [input.runId, input.userId, input.priority ?? 0]
    );
    return res.rows[0]!;
  }

  async getJobByRunId(runId: string): Promise<DbJob | null> {
    const res = await this.pool.query<DbJob>(
      `SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId]
    );
    return res.rows[0] ?? null;
  }

  async leaseNextJob(input: { leaseOwner: string; leaseMs: number }): Promise<DbJob | null> {
    const leaseInterval = `${Math.max(1, Math.floor(input.leaseMs))} milliseconds`;

    const res = await this.pool.query<DbJob>(
      `
        WITH candidate AS (
          SELECT j.id
          FROM jobs j
          JOIN runs r ON r.id = j.run_id
          WHERE
            (
              j.status = 'queued'
              OR (j.status IN ('leased', 'running') AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < now())
            )
            AND j.status != 'canceled'
            AND j.attempts < j.max_attempts
            AND r.status IN ('queued', 'running')
            AND (
              SELECT count(*)
              FROM jobs jj
              WHERE jj.user_id = j.user_id
                AND jj.status IN ('leased', 'running')
                AND jj.lease_expires_at IS NOT NULL
                AND jj.lease_expires_at > now()
            ) < (
              SELECT COALESCE(
                NULLIF(regexp_replace(u.policy->>'maxConcurrentJobs', '[^0-9]', '', 'g'), '')::int,
                1
              )
              FROM users u
              WHERE u.id = j.user_id
            )
          ORDER BY j.priority DESC, j.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs j
        SET
          status = 'leased',
          attempts = j.attempts + 1,
          lease_owner = $1,
          lease_expires_at = now() + $2::interval,
          updated_at = now()
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
      `,
      [input.leaseOwner, leaseInterval]
    );

    return res.rows[0] ?? null;
  }

  async markJobRunning(input: { jobId: string; leaseOwner: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'leased'
      `,
      [input.jobId, input.leaseOwner]
    );
  }

  async heartbeatJob(input: {
    jobId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean> {
    const leaseInterval = `${Math.max(1, Math.floor(input.leaseMs))} milliseconds`;
    const res = await this.pool.query(
      `
        UPDATE jobs
        SET lease_expires_at = now() + $3::interval, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status IN ('leased', 'running')
      `,
      [input.jobId, input.leaseOwner, leaseInterval]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async completeJob(jobId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'completed', finished_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [jobId]
    );
  }

  async failJob(jobId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'failed', finished_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [jobId]
    );
  }

  async requeueJob(jobId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('leased', 'running', 'failed')
      `,
      [jobId]
    );
  }

  async getJob(jobId: string): Promise<DbJob | null> {
    const res = await this.pool.query<DbJob>("SELECT * FROM jobs WHERE id = $1", [jobId]);
    return res.rows[0] ?? null;
  }

  async listJobs(opts?: { status?: JobStatus; limit?: number }): Promise<DbJob[]> {
    const limit = opts?.limit ?? 200;
    const res = await this.pool.query<DbJob>(
      opts?.status
        ? `SELECT * FROM jobs WHERE status = $1 ORDER BY priority DESC, created_at ASC LIMIT $2`
        : `SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1`,
      opts?.status ? [opts.status, limit] : [limit]
    );
    return res.rows;
  }

  async cancelJob(jobId: string, reason?: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE jobs
        SET status = 'canceled', canceled_at = now(), cancel_reason = $2, updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'leased', 'running')
      `,
      [jobId, reason ?? null]
    );
  }

  async reprioritizeJob(jobId: string, priority: number): Promise<void> {
    await this.pool.query(`UPDATE jobs SET priority = $2, updated_at = now() WHERE id = $1`, [
      jobId,
      priority,
    ]);
  }

  // --- Sources ---

  async createSource(input: { runId: string; url: string }): Promise<DbSource> {
    const res = await this.pool.query<DbSource>(
      `INSERT INTO sources (run_id, url) VALUES ($1, $2) RETURNING *`,
      [input.runId, input.url]
    );
    return res.rows[0]!;
  }

  async updateSource(input: {
    sourceId: string;
    status?: SourceStatus;
    finalUrl?: string | null;
    httpStatus?: number | null;
    contentType?: string | null;
    contentHash?: string | null;
    fetchedAt?: Date | null;
    title?: string | null;
    publisher?: string | null;
    authors?: string[] | null;
    publishedAt?: Date | null;
    rawBodyKey?: string | null;
    renderTextKey?: string | null;
    renderHtmlKey?: string | null;
    renderTraceKey?: string | null;
    extractKey?: string | null;
    error?: unknown | null;
  }): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [input.sourceId];

    const push = (sql: string, value: unknown) => {
      fields.push(sql.replace("$v", `$${values.length + 1}`));
      values.push(value);
    };

    if (input.status !== undefined) push("status = $v", input.status);
    if (input.finalUrl !== undefined) push("final_url = $v", input.finalUrl);
    if (input.httpStatus !== undefined) push("http_status = $v", input.httpStatus);
    if (input.contentType !== undefined) push("content_type = $v", input.contentType);
    if (input.contentHash !== undefined) push("content_hash = $v", input.contentHash);
    if (input.fetchedAt !== undefined) push("fetched_at = $v", input.fetchedAt);
    if (input.title !== undefined) push("title = $v", input.title);
    if (input.publisher !== undefined) push("publisher = $v", input.publisher);
    if (input.authors !== undefined) push("authors = $v", input.authors);
    if (input.publishedAt !== undefined) push("published_at = $v", input.publishedAt);
    if (input.rawBodyKey !== undefined) push("raw_body_key = $v", input.rawBodyKey);
    if (input.renderTextKey !== undefined) push("render_text_key = $v", input.renderTextKey);
    if (input.renderHtmlKey !== undefined) push("render_html_key = $v", input.renderHtmlKey);
    if (input.renderTraceKey !== undefined) push("render_trace_key = $v", input.renderTraceKey);
    if (input.extractKey !== undefined) push("extract_key = $v", input.extractKey);
    if (input.error !== undefined) push("error = $v", input.error);

    if (fields.length === 0) return;
    fields.push("updated_at = now()");
    await this.pool.query(`UPDATE sources SET ${fields.join(", ")} WHERE id = $1`, values);
  }

  async listSources(runId: string): Promise<DbSource[]> {
    const res = await this.pool.query<DbSource>(
      `SELECT * FROM sources WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    return res.rows;
  }

  // --- Model calls ---

  async addModelCall(input: {
    runId: string;
    phase: string;
    modelId: string;
    params?: unknown;
    promptVersion?: string;
    inputHash?: string;
    outputHash?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    requestKey?: string;
    responseKey?: string;
  }): Promise<DbModelCall> {
    const res = await this.pool.query<DbModelCall>(
      `
        INSERT INTO model_calls (
          run_id, phase, model_id, params, prompt_version, input_hash, output_hash,
          tokens_in, tokens_out, cost_usd, request_key, response_key
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `,
      [
        input.runId,
        input.phase,
        input.modelId,
        input.params ?? {},
        input.promptVersion ?? null,
        input.inputHash ?? null,
        input.outputHash ?? null,
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        input.costUsd ?? null,
        input.requestKey ?? null,
        input.responseKey ?? null,
      ]
    );
    return res.rows[0]!;
  }

  // --- Citations ---

  async addCitation(input: {
    runId: string;
    claimId: string;
    sourceId: string;
    quoteStart?: number;
    quoteEnd?: number;
  }): Promise<DbCitation> {
    const res = await this.pool.query<DbCitation>(
      `
        INSERT INTO citations (run_id, claim_id, source_id, quote_start, quote_end)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
      `,
      [input.runId, input.claimId, input.sourceId, input.quoteStart ?? null, input.quoteEnd ?? null]
    );
    return res.rows[0]!;
  }
}
