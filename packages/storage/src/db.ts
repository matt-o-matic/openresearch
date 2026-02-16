import pg from "pg";

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export function createPool(databaseUrl: string): PgPool {
  return new pg.Pool({ connectionString: databaseUrl });
}
