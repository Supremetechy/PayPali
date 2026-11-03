// Run the PayPali MCP stdio server bound to ONE already-funded agent, sharing the
// web app's Postgres. Bundles the env the connector needs so `claude mcp add` /
// Claude Desktop can launch it with just: npm run mcp:agent
//
//   Required:  PAYPALI_AGENT_ID       the funded agent Claude should drive
//   Defaults:  PAYPALI_DATABASE_URL   ← DATABASE_URL from .env, else local Postgres
//              PAYPAL_ENV             ← sandbox
//   PayPal:    PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET come from .env (real sandbox calls)
//
// stdout is the JSON-RPC channel, so every line this script prints goes to stderr.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const DEFAULT_PG = 'postgresql://paypali:paypali@localhost:5432/paypali?schema=public';
process.env.PAYPALI_DATABASE_URL ??= process.env.DATABASE_URL ?? DEFAULT_PG;
process.env.PAYPAL_ENV ??= 'sandbox';

if (!process.env.PAYPALI_AGENT_ID) {
  process.stderr.write(
    '[mcp:agent] PAYPALI_AGENT_ID is required — the funded agent to drive.\n' +
    '            Find it in the dashboard, or:\n' +
    "            curl -s localhost:4000/api/agents -H \"x-paypali-admin: $(grep PAYPALI_ADMIN_TOKEN .data/secrets.json | cut -d'\"' -f4)\" | jq '.agents[] | {id,name,accounts}'\n" +
    '            Then: PAYPALI_AGENT_ID=<id> npm run mcp:agent  (or set it in the connector env)\n',
  );
  process.exit(2);
}
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  process.stderr.write('[mcp:agent] note: no PAYPAL_CLIENT_ID/SECRET — tools will use the DEV gateway, not real PayPal sandbox.\n');
}

process.stderr.write(`[mcp:agent] agent=${process.env.PAYPALI_AGENT_ID} env=${process.env.PAYPAL_ENV} db=${process.env.PAYPALI_DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}\n`);

// Hand off to the existing builder/runner (esbuild bundle → run the stdio server).
await import('./mcp.mjs');
