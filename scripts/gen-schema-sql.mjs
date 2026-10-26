// Generates the full Postgres DDL for the current Prisma datamodel and writes it
// to tests/.generated/schema.sql. The committed migration is incremental (it
// ALTERs a pre-existing PaymentIntent), so it cannot build the schema from empty;
// `migrate diff --from-empty` derives the complete DDL straight from schema.prisma
// without ever connecting to a database. The test harness execs this into PGlite.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'tests/.generated/schema.sql');
mkdirSync(dirname(out), { recursive: true });

const sql = execFileSync(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);

const { writeFileSync } = await import('node:fs');
writeFileSync(out, sql, 'utf8');
console.log(`Wrote ${out} (${sql.length} bytes)`);
