import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Secrets management.
//
// Every secret PayPali reads from the environment can instead be delivered as a
// file, by setting <NAME>_FILE to a path. The file's trimmed contents become the
// value. This is the standard way to pass secrets into a container without baking
// them into the image or an env var that shows up in `docker inspect`/`ps`:
//   • Docker/Compose secrets mount at /run/secrets/<name>
//   • Kubernetes secrets mount as files in a volume
//
// A plain <NAME> always wins over <NAME>_FILE, so local .env development is
// unchanged. hydrateSecrets() copies any _FILE value into the plain variable so
// the rest of the code keeps reading process.env as before.
// ---------------------------------------------------------------------------

/** Secrets that may be delivered as <NAME>_FILE. Plain env vars still work and win. */
export const SECRET_NAMES = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPALI_DATABASE_URL',
  'DATABASE_URL',
  'PAYPALI_KEY_ENCRYPTION_KEY',
  'PAYPALI_IDENTITY_ISSUER_KEY',
  'PAYPALI_KYC_FINGERPRINT_KEY',
  'PAYPALI_ADMIN_TOKEN',
  'PAYPALI_PORTAL_WEBHOOK_SECRET',
  'PAYPALI_MERCHANTS',
] as const;

type Env = Record<string, string | undefined>;

/** Resolve one secret: the plain variable if set and non-empty, else the file named by <NAME>_FILE. */
export function resolveSecret(name: string, env: Env = process.env): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const fileRef = env[`${name}_FILE`];
  if (fileRef && fileRef.trim()) {
    try {
      const v = readFileSync(fileRef.trim(), 'utf8').replace(/\s+$/, '');
      return v === '' ? undefined : v;
    } catch {
      throw new Error(`SECRET_FILE_UNREADABLE:${name}_FILE`);
    }
  }
  return undefined;
}

/** Copy every <NAME>_FILE value into its plain variable so downstream code reads process.env unchanged. */
export function hydrateSecrets(names: readonly string[] = SECRET_NAMES, env: Env = process.env): string[] {
  const loaded: string[] = [];
  for (const n of names) {
    if ((env[n] === undefined || env[n] === '') && env[`${n}_FILE`]) {
      const v = resolveSecret(n, env);
      if (v !== undefined) { env[n] = v; loaded.push(n); }
    }
  }
  return loaded;
}

/** A value safe to log: first and last couple of characters only, never the secret itself. */
export function redact(v: string | undefined): string {
  if (!v) return '(unset)';
  return v.length <= 8 ? '***' : `${v.slice(0, 3)}…${v.slice(-2)} (${v.length})`;
}
