import { readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';

// ---------------------------------------------------------------------------
// Where PayPali keeps its data.
//
//   (default)                 in-memory Postgres (PGlite): resets on restart. Tests and quick demos.
//   PAYPALI_DATA_DIR=.data/db  Postgres (PGlite) on disk: survives restarts. Local demos and review.
//   PAYPALI_DATABASE_URL=postgres://…  an external Postgres (uses the Prisma query engine).
//
// A fresh database gets the full schema (tests/.generated/schema.sql) and every migration is
// recorded as applied. An existing one gets each prisma/migrations/* it hasn't seen yet, in order,
// so upgrading PayPali never loses data. Applied migrations are tracked in "_paypali_migrations".
// ---------------------------------------------------------------------------

type Exec = { exec(sql: string): Promise<unknown>; rows(sql: string): Promise<Array<Record<string, unknown>>> };

export async function migrate(db: Exec, root: string, log: (m: string) => void = () => undefined) {
  const dir = resolve(root, 'prisma/migrations');
  const names = existsSync(dir) ? (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  const fresh = (await db.rows(`SELECT to_regclass('public."Owner"') AS t`))[0]?.t == null;
  await db.exec(`CREATE TABLE IF NOT EXISTS "_paypali_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  if (fresh) {
    await db.exec(await readFile(resolve(root, 'tests/.generated/schema.sql'), 'utf8'));
    for (const n of names) await db.exec(`INSERT INTO "_paypali_migrations" ("name") VALUES ('${n.replace(/'/g, "''")}') ON CONFLICT DO NOTHING`);
    log(`[db] new database: schema created (${names.length} migrations recorded)`);
    return { fresh: true, applied: [] as string[] };
  }
  const done = new Set((await db.rows(`SELECT "name" FROM "_paypali_migrations"`)).map((r) => String(r.name)));
  // A database created before migration tracking existed: everything up to now is already in it.
  if (done.size === 0) {
    for (const n of names) await db.exec(`INSERT INTO "_paypali_migrations" ("name") VALUES ('${n.replace(/'/g, "''")}') ON CONFLICT DO NOTHING`);
    log('[db] existing database adopted: all migrations marked applied');
    return { fresh: false, applied: [] as string[] };
  }
  const applied: string[] = [];
  for (const n of names) {
    if (done.has(n)) continue;
    const sql = await readFile(resolve(dir, n, 'migration.sql'), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO "_paypali_migrations" ("name") VALUES ('${n.replace(/'/g, "''")}');\nCOMMIT;`);
    applied.push(n);
  }
  if (applied.length) log(`[db] applied migrations: ${applied.join(', ')}`);
  return { fresh: false, applied };
}

export async function bootDatabase(root: string, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = (m) => console.log(m)): Promise<{ prisma: PrismaClient; mode: string }> {
  const url = env.PAYPALI_DATABASE_URL;
  if (url) {
    const prisma = new PrismaClient({ datasourceUrl: url } as any);
    await migrate({
      // Prisma runs one statement per call: split the script and run it as one transaction.
      exec: async (sql) => { const stmts = splitSql(sql).filter((x) => !/^(BEGIN|COMMIT)$/i.test(x)); await prisma.$transaction(stmts.map((x) => prisma.$executeRawUnsafe(x))); },
      rows: (sql) => prisma.$queryRawUnsafe(sql) as Promise<Array<Record<string, unknown>>>,
    }, root, log);
    return { prisma, mode: 'postgres' };
  }
  const dir = env.PAYPALI_DATA_DIR ? resolve(root, env.PAYPALI_DATA_DIR) : null;
  if (dir) await mkdir(dir, { recursive: true });
  const pglite = dir ? new PGlite(dir) : new PGlite();
  await migrate({ exec: (sql) => pglite.exec(sql), rows: async (sql) => (await pglite.query(sql)).rows as Array<Record<string, unknown>> }, root, dir ? log : () => undefined);
  // pglite-prisma-adapter ships its own driver-adapter-utils major; shapes match and are cast at the seam.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPGlite(pglite) as any;
  return { prisma: new PrismaClient({ adapter }), mode: dir ? `pglite:${dir}` : 'memory' };
}

/** Split a migration script into statements (no procedural blocks in Prisma-generated DDL). */
export function splitSql(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
}
