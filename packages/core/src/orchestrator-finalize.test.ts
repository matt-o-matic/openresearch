import { describe, expect, it } from "vitest";

import type { HttpFetchAdapter, SearchAdapter } from "./adapters.js";
import { OpenResearchConfigSchema } from "./config.js";
import type { ObjectStore, PipelineRunRow, PipelineSourceRow, PipelineStore, RunCheckpoint } from "./orchestrator.js";
import { runResearchPipeline } from "./orchestrator.js";
import { runOutputKey } from "./artifacts.js";

class MemoryObjectStore implements ObjectStore {
  private readonly json = new Map<string, unknown>();
  private readonly text = new Map<string, string>();
  private readonly bytes = new Map<string, Uint8Array>();

  async putJson(key: string, value: unknown): Promise<void> {
    this.json.set(key, value);
  }

  async putText(key: string, value: string): Promise<void> {
    this.text.set(key, value);
  }

  async putBytes(key: string, value: Uint8Array): Promise<void> {
    this.bytes.set(key, value);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.json.has(key)) return null;
    return this.json.get(key) as T;
  }

  async getText(key: string): Promise<string | null> {
    return this.text.get(key) ?? null;
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.bytes.get(key) ?? null;
  }
}

type MemoryRunRow = PipelineRunRow & {
  started_at?: Date | null;
  finished_at?: Date | null;
  error?: unknown;
};

class MemoryPipelineStore implements PipelineStore {
  private readonly runs = new Map<string, MemoryRunRow>();

  constructor(opts: { runId: string; userId: string; prompt: string; state: RunCheckpoint }) {
    this.runs.set(opts.runId, {
      id: opts.runId,
      user_id: opts.userId,
      prompt: opts.prompt,
      status: "queued",
      phase: opts.state.nextPhase,
      citation_policy: "balanced",
      template: "research-memo",
      budgets: {},
      model_config: {},
      adapter_config: {},
      state: opts.state,
    });
  }

  async getRun(runId: string): Promise<PipelineRunRow | null> {
    return this.runs.get(runId) ?? null;
  }

  async updateRun(input: Parameters<PipelineStore["updateRun"]>[0]): Promise<void> {
    const row = this.runs.get(input.runId);
    if (!row) return;
    if (input.status !== undefined) row.status = input.status;
    if (input.phase !== undefined) row.phase = input.phase;
    if (input.state !== undefined) row.state = input.state;
    if (input.error !== undefined) row.error = input.error;
    if (input.startedAt !== undefined) row.started_at = input.startedAt;
    if (input.finishedAt !== undefined) row.finished_at = input.finishedAt;
  }

  async addRunEvent(): Promise<unknown> {
    return {};
  }

  async addUsageDelta(): Promise<void> {}

  async listSources(): Promise<PipelineSourceRow[]> {
    return [];
  }

  async createSource(): Promise<PipelineSourceRow> {
    throw new Error("not implemented");
  }

  async updateSource(): Promise<void> {}

  async addModelCall(): Promise<unknown> {
    return {};
  }

  async addCitation(): Promise<unknown> {
    return {};
  }
}

describe("runResearchPipeline", () => {
  it("finalizes best-effort output when synthesis artifacts are missing", async () => {
    const runId = "run-finalize-missing-artifacts";
    const userId = "user";
    const prompt = "Write a memo.";
    const checkpoint: RunCheckpoint = {
      version: 1,
      nextPhase: "finalize",
      counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
      artifacts: {},
      debug: { enabled: false },
    };

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const objectStore = new MemoryObjectStore();
    const config = OpenResearchConfigSchema.parse({ env: "test" });

    const search: SearchAdapter = {
      name: "mock-search",
      async search() {
        return [];
      },
    };
    const httpFetch: HttpFetchAdapter = {
      name: "mock-http",
      async fetch(url: string) {
        return { ok: false as const, url, status: null, error: "not used" };
      },
    };

    await runResearchPipeline({
      runId,
      config,
      services: {
        store,
        objectStore,
        search,
        httpFetch,
      },
    });

    const run = await store.getRun(runId);
    expect(run?.status).toBe("completed");
    const output = await objectStore.getText(runOutputKey(runId));
    expect(output).not.toBeNull();
    expect(output && output.trim().length > 0).toBe(true);
  });
});

