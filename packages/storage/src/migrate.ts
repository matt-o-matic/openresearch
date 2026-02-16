import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PgClient, PgPool } from "./db.js";

async function ensureMigrationsTable(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function runMigrations(opts: {
  pool: PgPool;
  migrationsDir: string;
}): Promise<{ applied: string[] }> {
  const migrationsDir = opts.migrationsDir;
  const pool = opts.pool;
  const applied: string[] = [];

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const existing = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name ASC"
    );
    const existingSet = new Set(existing.rows.map((r) => r.name));

    for (const file of files) {
      if (existingSet.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      applied.push(file);
    }
  } finally {
    client.release();
  }

  return { applied };
}
