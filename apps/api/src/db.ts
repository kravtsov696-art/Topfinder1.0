import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Sql = postgres.Sql<Record<string, never>>;

export function createDb(url: string): Sql {
  const ssl = /sslmode=require/.test(url) ? 'require' : undefined;
  return postgres(url, {
    max: 10,
    ssl: ssl as 'require' | undefined,
    onnotice: () => {},
    // timestamptz отдаём как Date; bigint как строку не нужен — id точек не уходят в клиент
    types: {},
  }) as unknown as Sql;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(sql: Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name as string));
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const text = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    });
    done.push(f);
  }
  return done;
}

export async function hasPostgis(sql: Sql): Promise<boolean> {
  const r = await sql`SELECT 1 FROM pg_extension WHERE extname = 'postgis'`;
  return r.length > 0;
}
