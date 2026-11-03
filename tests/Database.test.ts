import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrate, splitSql } from '../src/server/database';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pg = (db: PGlite) => ({ exec: (s: string) => db.exec(s), rows: async (s: string) => (await db.query(s)).rows as Array<Record<string, unknown>> });

describe('Persistent database and migrations', () => {
  it('a fresh database gets the full schema and records every migration; data survives a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-db-'));
    const db = new PGlite(dir);
    const r = await migrate(pg(db), ROOT);
    expect(r.fresh).toBe(true);
    const recorded = (await db.query<{ name: string }>('SELECT name FROM "_paypali_migrations" ORDER BY name')).rows.map((x) => x.name);
    expect(recorded).toContain('20261104090000_funding_agency');
    await db.exec(`INSERT INTO "Owner" (id, email, "createdAt", "updatedAt") VALUES ('o1', 'keep@example.com', now(), now())`);
    await db.close();
    const again = new PGlite(dir);
    expect((await migrate(pg(again), ROOT)).applied).toEqual([]);
    expect((await again.query('SELECT email FROM "Owner"')).rows).toEqual([{ email: 'keep@example.com' }]);
    await again.close();
  }, 60_000);

  it('an existing database gets only the migrations it has not seen, in order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-root-'));
    mkdirSync(join(root, 'tests/.generated'), { recursive: true });
    cpSync(join(ROOT, 'tests/.generated/schema.sql'), join(root, 'tests/.generated/schema.sql'));
    mkdirSync(join(root, 'prisma/migrations/20990101000000_a'), { recursive: true });
    writeFileSync(join(root, 'prisma/migrations/20990101000000_a/migration.sql'), 'CREATE TABLE "Zed" (id TEXT PRIMARY KEY);');
    const db = new PGlite();
    await migrate(pg(db), root);                         // fresh: schema + "a" recorded (not run)
    mkdirSync(join(root, 'prisma/migrations/20990102000000_b'), { recursive: true });
    writeFileSync(join(root, 'prisma/migrations/20990102000000_b/migration.sql'), '-- new table\nCREATE TABLE "Yak" (id TEXT PRIMARY KEY);\nINSERT INTO "Yak" VALUES (\'y\');');
    const r = await migrate(pg(db), root);
    expect(r.applied).toEqual(['20990102000000_b']);
    expect((await db.query('SELECT id FROM "Yak"')).rows).toEqual([{ id: 'y' }]);
    await db.close();
  }, 60_000);

  it('splits scripts into statements for Postgres (one statement per Prisma call)', () => {
    expect(splitSql('-- c\nCREATE TABLE a (x int);\nCREATE INDEX i ON a(x);\n')).toEqual(['CREATE TABLE a (x int)', 'CREATE INDEX i ON a(x)']);
  });
});
