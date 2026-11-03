// Bundles the TypeScript dev server with esbuild (deps kept external) and runs
// it. esbuild is already a project dependency; this avoids needing tsx/ts-node.
import { build } from 'esbuild';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Emit inside the project so Node resolves the external deps (@prisma/client,
// @electric-sql/pglite, …) from the project's own node_modules.
// PayPal credentials and other settings from .env (values already in the environment win).
if (existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));

const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'paypali');
mkdirSync(cacheDir, { recursive: true });
const outfile = join(cacheDir, `server-${process.pid}-${Date.now()}.mjs`);

await build({
  entryPoints: ['src/server/paypaliServer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external', // keep @prisma/client, pglite, etc. resolving from node_modules
  outfile,
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
