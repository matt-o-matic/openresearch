import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GenericContainer, Wait } from "testcontainers";
import pg from "pg";

import { PostgresStore } from "./postgres-store.js";

describe("PostgresStore", () => {
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
  let store: PostgresStore | undefined;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_USER: "openresearch",
        POSTGRES_PASSWORD: "openresearch",
        POSTGRES_DB: "openresearch",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections"))
      .start();

    const databaseUrl = `postgres://openresearch:openresearch@${container.getHost()}:${container.getMappedPort(
      5432
    )}/openresearch`;

    store = new PostgresStore({ databaseUrl });
    const deadline = Date.now() + 30_000;
    // Some Docker environments emit readiness logs slightly before connections are accepted.
    for (;;) {
      try {
        await store.migrate();
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await container?.stop();
  });

  it("creates and authenticates API keys", async () => {
    const user = await store!.createUser({ role: "admin", email: "admin@example.com" });
    const { apiKey, row } = await store!.createApiKey({ userId: user.id, label: "test" });

    const authed = await store!.authenticateApiKey(apiKey);
    expect(authed?.user.id).toBe(user.id);
    expect(authed?.user.role).toBe("admin");
    expect(authed?.apiKey.id).toBe(row.id);

    await store!.revokeApiKey(row.id);
    const authedAfterRevoke = await store!.authenticateApiKey(apiKey);
    expect(authedAfterRevoke).toBeNull();
  });

  it("tracks usage deltas", async () => {
    const user = await store!.createUser({ role: "user" });
    await store!.addUsageDelta({
      userId: user.id,
      searchCalls: 2,
      fetches: 3,
      renders: 1,
      modelTokensIn: 10,
      modelTokensOut: 20,
      costUsd: 0.12,
    });

    const usage = await store!.getUsageMonth(user.id);
    expect(usage.search_calls).toBe(2);
    expect(usage.fetches).toBe(3);
    expect(usage.renders).toBe(1);
    expect(usage.model_tokens_in).toBe(10);
    expect(usage.model_tokens_out).toBe(20);
    expect(Number(usage.cost_usd)).toBeCloseTo(0.12, 6);
  });

  it("creates runs, jobs, sources, and events", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "test prompt",
      qualityTier: "full",
    });
    const job = await store!.createJob({ runId: run.id, userId: user.id, priority: 5 });
    const source = await store!.createSource({ runId: run.id, url: "https://example.com" });
    const ev = await store!.addRunEvent({
      runId: run.id,
      level: "info",
      phase: "plan",
      eventType: "phase_started",
      message: "Plan started",
    });

    expect(run.status).toBe("queued");
    expect(job.status).toBe("queued");
    expect(source.status).toBe("pending");
    expect(ev.event_type).toBe("phase_started");

    await store!.updateSource({ sourceId: source.id, status: "failed", error: { msg: "nope" } });
    const sources = await store!.listSources(run.id);
    expect(sources[0]?.status).toBe("failed");
  });

  it("leases jobs by priority and enforces per-user concurrency", async () => {
    const user = await store!.createUser({ role: "user" });
    await store!.setUserPolicy(user.id, {
      requestsPerMinute: 60,
      maxConcurrentJobs: 1,
      downgradeThreshold: {},
      braveSearchQuota: 0,
    });

    const runA = await store!.createRun({ userId: user.id, prompt: "A" });
    const runB = await store!.createRun({ userId: user.id, prompt: "B" });
    const jobA = await store!.createJob({ runId: runA.id, userId: user.id, priority: 100 });
    const jobB = await store!.createJob({ runId: runB.id, userId: user.id, priority: 200 });

    const leased1 = await store!.leaseNextJob({ leaseOwner: "t1", leaseMs: 10_000 });
    expect(leased1?.id).toBe(jobB.id);
    expect(leased1?.status).toBe("leased");

    const leased2 = await store!.leaseNextJob({ leaseOwner: "t1", leaseMs: 10_000 });
    expect(leased2?.id).not.toBe(jobA.id);
    const jobAAfter = await store!.getJob(jobA.id);
    expect(jobAAfter?.status).toBe("queued");

    await store!.completeJob(jobB.id);

    const leased3 = await store!.leaseNextJob({ leaseOwner: "t1", leaseMs: 10_000 });
    expect(leased3?.id).toBe(jobA.id);

    await store!.cancelJob(jobA.id, "test cancel");
    const leased4 = await store!.leaseNextJob({ leaseOwner: "t1", leaseMs: 10_000 });
    expect(leased4).toBeNull();
  });

  it("reprioritizes queued jobs and affects leasing order", async () => {
    const user = await store!.createUser({ role: "user" });
    await store!.setUserPolicy(user.id, {
      requestsPerMinute: 60,
      maxConcurrentJobs: 1,
      downgradeThreshold: {},
      braveSearchQuota: 0,
    });

    const runA = await store!.createRun({ userId: user.id, prompt: "A" });
    const runB = await store!.createRun({ userId: user.id, prompt: "B" });
    const jobA = await store!.createJob({ runId: runA.id, userId: user.id, priority: 1 });
    const jobB = await store!.createJob({ runId: runB.id, userId: user.id, priority: 2 });

    await store!.reprioritizeJob(jobA.id, 999);

    const leased = await store!.leaseNextJob({ leaseOwner: "t2", leaseMs: 10_000 });
    expect(leased?.id).toBe(jobA.id);

    await store!.cancelJob(jobA.id, "cleanup");
    await store!.cancelJob(jobB.id, "cleanup");
  });

  it("re-leases expired running jobs (restart recovery)", async () => {
    const user = await store!.createUser({ role: "user" });
    await store!.setUserPolicy(user.id, {
      requestsPerMinute: 60,
      maxConcurrentJobs: 1,
      downgradeThreshold: {},
      braveSearchQuota: 0,
    });

    const run = await store!.createRun({ userId: user.id, prompt: "recovery test" });
    const job = await store!.createJob({ runId: run.id, userId: user.id, priority: 500 });

    const leased = await store!.leaseNextJob({ leaseOwner: "w1", leaseMs: 10_000 });
    expect(leased?.id).toBe(job.id);
    await store!.markJobRunning({ jobId: job.id, leaseOwner: "w1" });

    const client = new pg.Client({ connectionString: store!.databaseUrl });
    await client.connect();
    try {
      await client.query(
        `UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [job.id]
      );
    } finally {
      await client.end();
    }

    const reLeased = await store!.leaseNextJob({ leaseOwner: "w2", leaseMs: 10_000 });
    expect(reLeased?.id).toBe(job.id);
    expect(reLeased?.lease_owner).toBe("w2");
  });
});
