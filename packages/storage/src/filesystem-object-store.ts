import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ObjectStoreListItem = {
  key: string;
  bytes: number;
  updatedAt: string;
};

function normalizeKey(key: string): string {
  const cleaned = key.replaceAll("\\", "/");
  if (cleaned.startsWith("/")) throw new Error("ObjectStore key must be relative");
  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith("..")) throw new Error("ObjectStore key escapes root");
  return normalized;
}

export class FilesystemObjectStore {
  readonly rootPath: string;

  constructor(opts: { rootPath: string }) {
    this.rootPath = opts.rootPath;
  }

  private toFsPath(key: string): string {
    const normalized = normalizeKey(key);
    return path.join(this.rootPath, ...normalized.split("/"));
  }

  async putBytes(key: string, data: Uint8Array): Promise<void> {
    const filePath = this.toFsPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  }

  async putText(key: string, text: string): Promise<void> {
    await this.putBytes(key, new TextEncoder().encode(text));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putText(key, JSON.stringify(value, null, 2));
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const filePath = this.toFsPath(key);
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  async getText(key: string): Promise<string | null> {
    const bytes = await this.getBytes(key);
    if (!bytes) return null;
    return new TextDecoder().decode(bytes);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    if (!text) return null;
    return JSON.parse(text) as T;
  }

  createReadStream(key: string) {
    const filePath = this.toFsPath(key);
    return createReadStream(filePath);
  }

  async stat(key: string): Promise<{ bytes: number; updatedAt: string } | null> {
    const filePath = this.toFsPath(key);
    try {
      const s = await stat(filePath);
      if (!s.isFile()) return null;
      return { bytes: s.size, updatedAt: s.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<ObjectStoreListItem[]> {
    const normalizedPrefix = normalizeKey(prefix);
    const baseFsPath = this.toFsPath(normalizedPrefix);
    const out: ObjectStoreListItem[] = [];

    const walk = async (dirFsPath: string, dirKeyPrefix: string): Promise<void> => {
      try {
        const entries = await readdir(dirFsPath, { withFileTypes: true });
        for (const ent of entries) {
          const name = ent.name;
          const entFsPath = path.join(dirFsPath, name);
          const entKey = dirKeyPrefix ? `${dirKeyPrefix}/${name}` : name;
          if (ent.isDirectory()) {
            await walk(entFsPath, entKey);
            continue;
          }
          if (!ent.isFile()) continue;
          const s = await stat(entFsPath);
          out.push({
            key: `${normalizedPrefix}/${entKey}`.replace(/^\/+/, ""),
            bytes: s.size,
            updatedAt: s.mtime.toISOString(),
          });
        }
      } catch {
        return;
      }
    };

    await walk(baseFsPath, "");
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }
}
