import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CacheEnvelope<T> = {
  createdAt: string;
  expiresAt: string;
  value: T;
};

export class DiskCache {
  readonly enabled: boolean;
  readonly rootPath: string;
  readonly ttlMs: number;

  constructor(opts: { enabled: boolean; rootPath: string; ttlMs: number }) {
    this.enabled = opts.enabled;
    this.rootPath = opts.rootPath;
    this.ttlMs = opts.ttlMs;
  }

  private filePath(namespace: string, key: string): string {
    const safeNs = namespace.replaceAll("..", "__").replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    const safeKey = key.replaceAll("..", "__").replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.rootPath, safeNs, `${safeKey}.json`);
  }

  async getJson<T>(namespace: string, key: string): Promise<T | null> {
    if (!this.enabled) return null;
    const fp = this.filePath(namespace, key);
    try {
      const raw = await readFile(fp, "utf8");
      const env = JSON.parse(raw) as CacheEnvelope<T>;
      if (Date.parse(env.expiresAt) <= Date.now()) return null;
      return env.value;
    } catch {
      return null;
    }
  }

  async setJson<T>(namespace: string, key: string, value: T): Promise<void> {
    if (!this.enabled) return;
    const fp = this.filePath(namespace, key);
    await mkdir(path.dirname(fp), { recursive: true });
    const env: CacheEnvelope<T> = {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      value,
    };
    await writeFile(fp, JSON.stringify(env, null, 2), "utf8");
  }
}
