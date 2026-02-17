import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import pg from "pg";

import { OpenResearchConfigSchema } from "@openresearch/core";
import { FilesystemObjectStore, PostgresStore } from "../../../packages/storage/src/index.js";

import { buildApiServer } from "./server.js";

describe("API resume", () => {
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
  let store: PostgresStore | undefined;
  let objectStore: FilesystemObjectStore | undefined;
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;
  let tmpDir: string | undefined;
  let databaseUrl: string | undefined;

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

    databaseUrl = `postgres://openresearch:openresearch@${container.getHost()}:${container.getMappedPort(
      5432
    )}/openresearch`;

    store = new PostgresStore({ databaseUrl });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await store.migrate();
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openresearch-api-test-"));
    objectStore = new FilesystemObjectStore({ rootPath: tmpDir });

    const config = OpenResearchConfigSchema.parse({
      env: "test",
      postgres: { url: databaseUrl },
      objectStore: { type: "filesystem", rootPath: tmpDir },
    });

    app = await buildApiServer({ config, store, objectStore });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await store?.close();
    await container?.stop();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function countJobs(runId: string): Promise<number> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const res = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM jobs WHERE run_id = $1",
        [runId]
      );
      return Number(res.rows[0]?.count ?? "0");
    } finally {
      await client.end();
    }
  }

  it("is owner-only", async () => {
    const userA = await store!.createUser({ role: "user" });
    const userB = await store!.createUser({ role: "user" });
    const { apiKey: apiKeyA } = await store!.createApiKey({ userId: userA.id });

    const runB = await store!.createRun({ userId: userB.id, prompt: "test prompt" });
    await store!.createJob({ runId: runB.id, userId: userB.id, priority: 0 });

    const res = await app!.inject({
      method: "POST",
      url: `/runs/${runB.id}/resume`,
      headers: { authorization: `Bearer ${apiKeyA}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it("is idempotent when already queued/running", async () => {
    const user = await store!.createUser({ role: "user" });
    const { apiKey } = await store!.createApiKey({ userId: user.id });

    const run = await store!.createRun({ userId: user.id, prompt: "test prompt" });
    const job = await store!.createJob({ runId: run.id, userId: user.id, priority: 0 });

    expect(await countJobs(run.id)).toBe(1);

    const res = await app!.inject({
      method: "POST",
      url: `/runs/${run.id}/resume`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; jobId: string | null; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.jobId).toBe(job.id);
    expect(await countJobs(run.id)).toBe(1);
  });

  it("restores from latest checkpoint and enqueues exactly one job", async () => {
    const user = await store!.createUser({ role: "user" });
    const { apiKey } = await store!.createApiKey({ userId: user.id });

    const run = await store!.createRun({ userId: user.id, prompt: "test prompt" });
    await store!.updateRun({
      runId: run.id,
      status: "failed",
      phase: null,
      state: null,
      error: { message: "simulated failure" },
      finishedAt: new Date(),
    });

    const pipelineCheckpoint = {
      version: 1,
      nextPhase: "verify",
      counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
      artifacts: {},
      debug: { enabled: false },
    };

    await store!.createRunCheckpoint({
      runId: run.id,
      kind: "iteration",
      checkpointVersion: 1,
      iterationCompleted: 1,
      payload: {
        version: 1,
        runId: run.id,
        createdAt: new Date().toISOString(),
        checkpointVersion: 1,
        kind: "iteration",
        iterationCompleted: 1,
        pipelineCheckpoint,
      },
    });

    expect(await countJobs(run.id)).toBe(0);

    const res1 = await app!.inject({
      method: "POST",
      url: `/runs/${run.id}/resume`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res1.statusCode).toBe(201);
    const body1 = res1.json() as { ok: boolean; jobId: string; restored: boolean };
    expect(body1.ok).toBe(true);
    expect(body1.restored).toBe(true);
    expect(await countJobs(run.id)).toBe(1);

    const updated = await store!.getRun(run.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.phase).toBe("verify");
    expect(updated?.state).toMatchObject(pipelineCheckpoint);
    expect(updated?.error).toBeNull();

    const res2 = await app!.inject({
      method: "POST",
      url: `/runs/${run.id}/resume`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res2.statusCode).toBe(200);
    expect(await countJobs(run.id)).toBe(1);
  });
});
