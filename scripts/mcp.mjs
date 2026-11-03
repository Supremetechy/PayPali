// Bundles the TypeScript MCP stdio server with esbuild (deps external) and runs
// it. stdout is the JSON-RPC channel; build diagnostics go to stderr.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'paypali');
mkdirSync(cacheDir, { recursive: true });
const outfile = join(cacheDir, `mcp-${process.pid}-${Date.now()}.mjs`);

await build({
  entryPoints: ['src/mcp/paypaliMcpServer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile,
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
