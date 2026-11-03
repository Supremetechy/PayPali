// PayPali as one persistent server, for local review:   npm start
//
//   • data on disk in .data/db (PAYPALI_DATA_DIR), so restarts keep owners, agents, ledgers and orders
//   • stable secrets generated once into .data/secrets.json (key encryption, identity issuer, KYC
//     fingerprints, admin token): sealed keys and signed documents stay valid across restarts
//   • owner sign-in required for owner and agent routes (PAYPALI_REQUIRE_SESSION=1)
//   • every agent needs a signed Power of Agency before it can move money
//   • PayPal from .env: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox unless PAYPAL_ENV=production)
//
// Anything already set in the environment or .env wins over these defaults.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

// Secrets delivered as files (<NAME>_FILE, e.g. Docker/K8s secrets) populate their plain
// variable before the defaults below, so a mounted secret wins over a generated one.
// Canonical logic lives in src/server/secrets.ts; this mirrors it for the pre-boot step.
for (const name of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPALI_DATABASE_URL', 'DATABASE_URL',
  'PAYPALI_KEY_ENCRYPTION_KEY', 'PAYPALI_IDENTITY_ISSUER_KEY', 'PAYPALI_KYC_FINGERPRINT_KEY',
  'PAYPALI_ADMIN_TOKEN', 'PAYPALI_PORTAL_WEBHOOK_SECRET', 'PAYPALI_MERCHANTS']) {
  const ref = process.env[`${name}_FILE`];
  if ((!process.env[name] || process.env[name] === '') && ref) {
    try { process.env[name] = readFileSync(ref.trim(), 'utf8').replace(/\s+$/, ''); }
    catch { console.error(`[start] cannot read ${name}_FILE (${ref})`); process.exit(1); }
  }
}

const dataDir = join(root, '.data');
mkdirSync(dataDir, { recursive: true });

const secretsPath = join(dataDir, 'secrets.json');
let secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf8')) : null;
if (!secrets) {
  secrets = {
    PAYPALI_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PAYPALI_IDENTITY_ISSUER_KEY: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    PAYPALI_KYC_FINGERPRINT_KEY: randomBytes(32).toString('base64'),
    PAYPALI_ADMIN_TOKEN: randomBytes(16).toString('hex'),
  };
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  try { chmodSync(secretsPath, 0o600); } catch {}
  console.log(`[start] generated ${secretsPath} (keep it with .data/db; never commit it)`);
}
const defaults = {
  ...secrets,
  PAYPALI_DATA_DIR: '.data/db',
  PAYPALI_REQUIRE_SESSION: '1',
  PAYPALI_REQUIRE_POWER_OF_AGENCY: '1',
  PAYPALI_IDENTITY_ISSUER_ID: 'paypali',
  PAYPALI_KYC_PROVIDER: 'sandbox',   // set PAYPALI_KYC_PROVIDER=paypal once "Log in with PayPal" is enabled on your PayPal app
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

console.log(`[start] data ${process.env.PAYPALI_DATABASE_URL ? 'Postgres (PAYPALI_DATABASE_URL)' : process.env.PAYPALI_DATA_DIR} · PayPal ${process.env.PAYPAL_CLIENT_ID ? (process.env.PAYPAL_ENV === 'production' ? 'PRODUCTION' : 'sandbox') : 'not configured (dev funding page)'}`);
await import('./serve.mjs');
