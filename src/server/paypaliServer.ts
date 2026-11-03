import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { OnboardingService } from '../onboarding/OnboardingService';
import { AgentWalletService } from '../services/AgentWalletService';
import { AgentSkills } from '../skills/AgentSkills';
import { LivePaymentService } from '../services/LivePaymentService';
import { IPayPalCommerceGateway } from '../providers/paypal/IPayPalCommerceGateway';
import { DevPayPalCommerceGateway } from '../providers/paypal/DevPayPalCommerceGateway';
import { makePayPalCommerceGateway } from '../providers/paypal/PayPalCommerceSdkAdapters';
import { IBrowserCheckoutDriver } from '../providers/checkout/IBrowserCheckoutDriver';
import { DevBrowserCheckoutDriver } from '../providers/checkout/DevBrowserCheckoutDriver';
import { GstackBrowseCheckoutDriver } from '../providers/checkout/GstackBrowseCheckoutDriver';
import { SeedFundingWorker } from '../workers/SeedFundingWorker';
import { AgentDevService } from '../agentdev/AgentDevService';
import { judgeLive } from '../agentdev/ScoredExecutor';
import { MerchantConfig, MerchantService } from '../merchant/MerchantService';
import { verifyRequest } from '../merchant/signing';
import { AgentConnectService } from '../connect/AgentConnectService';
import { createConnectRoutes } from '../connect/httpRoutes';
import { StorefrontLinkService } from '../bazaar/StorefrontLink';
import { SkillMarket } from '../skills/SkillMarket';
import { registerDemoSkills, seedDemoSkills } from '../skills/demoSkills';
import { createSkillRoutes } from '../skills/httpRoutes';
import { GasPriceOracle, gasFloatFromEnv } from '../market/GasPrice';
import { createStorefrontLinkRoutes } from '../bazaar/linkRoutes';
import { isPublicUrl, setupFor } from '../connect/providers';
import { GasService } from '../market/GasService';
import { makePortalRegistry } from '../market/portals';
import { PortalSecretStore } from '../market/PortalSecretStore';
import { findService } from '../market/catalog';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { BazaarClient } from '../bazaar/BazaarClient';
import { IdentityIssuer } from '../bazaar/IdentityIssuer';
import { KycService } from '../bazaar/KycService';
import { SandboxKycProvider, kycProviderFromEnv } from '../bazaar/kycProviders';
import { timingSafeEqual } from 'node:crypto';
import { SessionService, safeNext } from '../auth/SessionService';
import { DataAgentService, DataFetch } from '../data/DataAgentService';
import { createDataRoutes } from '../data/httpRoutes';
import { createRequire } from 'node:module';
import { bootDatabase } from './database';
import { hydrateSecrets } from './secrets';
import { FundingService } from '../funding/FundingService';
import { fundingProviderFromEnv } from '../funding/providers';
import { createFundingRoutes } from '../funding/httpRoutes';
import { AgencyService } from '../agency/AgencyService';
import { createAgencyRoutes } from '../agency/httpRoutes';
import {
  IPayPalFundingGateway,
  SeedFundingRequest,
  SeedFundingResult,
} from '../providers/paypal/IPayPalFundingGateway';

// ---------------------------------------------------------------------------
// PayPali dev server — a "semi frontend" for manual testing.
//
// Serves the onboarding page and backs it with the *real* OnboardingService and
// SeedFundingWorker, running against an in-process PGlite Postgres (same engine
// the test harness uses). No credentials, no network: seed capture is handled by
// a dev funding gateway that always succeeds, so an onboarded agent actually
// funds and its wallet becomes spendable — the whole flow is observable in the
// browser. This is a test harness, not production: real funding must wire
// PayPalFundingGateway over the PayPal SDK instead of DevFundingGateway.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(process.cwd());
const SCHEMA_SQL_PATH = resolve(PROJECT_ROOT, 'tests/.generated/schema.sql');
const PAGE_PATH = resolve(PROJECT_ROOT, 'PayPali Onboarding.html');
const DASHBOARD_PATH = resolve(PROJECT_ROOT, 'PayPali Dashboard.html');
const MARKETPLACE_PATH = resolve(PROJECT_ROOT, 'PayPali Marketplace.html');
const LOGIN_PATH = resolve(PROJECT_ROOT, 'PayPali Login.html');
const TERMS_PATH = resolve(PROJECT_ROOT, 'legal/terms.md');
const PRIVACY_PATH = resolve(PROJECT_ROOT, 'legal/privacy.md');
const PORT = Number(process.env.PORT ?? 4000);

/** Dev seed-funding gateway: captures from the owner's "PayPal balance" every
 *  time. Stands in for PayPalFundingGateway so manual testing can watch a seed
 *  go from PENDING to a funded, spendable wallet without any real integration. */
class DevFundingGateway implements IPayPalFundingGateway {
  async captureFromBalance(req: SeedFundingRequest): Promise<SeedFundingResult> {
    return { status: 'CAPTURED', captureId: `dev_cap_${randomUUID()}` };
  }
}

// --- request/response helpers ---------------------------------------------

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, jsonReplacer, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

/** The request's own origin when it is a local dev host, so dev sign-in links land on the same cookie jar. */
function localOrigin(req: IncomingMessage): string | undefined {
  const host = String(req.headers.host ?? '');
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? `http://${host}` : undefined;
}

const escHtml = (x: unknown) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE_CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f4f5f2;color:#17201b}main{max-width:520px;margin:0 auto;padding:24px 16px}
label{display:block;font-size:.85rem;color:#4b5a52;margin-top:12px}input{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #cdd5ce;border-radius:6px;background:#fff}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:6px;border:1px solid #17201b;background:#17201b;color:#fff;margin:18px 8px 0 0;cursor:pointer}
button.alt{background:transparent;color:#17201b}button.no{background:transparent;color:#a33;border-color:#a33}.note{background:#fff4d6;border-radius:8px;padding:10px 12px;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#101612;color:#e4ece6}input{background:#18211b;color:#e4ece6;border-color:#2c3a31}button{background:#e4ece6;color:#101612;border-color:#e4ece6}button.alt{background:transparent;color:#e4ece6}.note{background:#3a3014}}`;

/** Dev-only page that plays Log in with PayPal (PAYPALI_KYC_PROVIDER=sandbox). */
function sandboxKycPage(id: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPal sign-in (sandbox)</title><style>${PAGE_CSS}</style></head>
<body><main><h1>PayPal sign-in (sandbox)</h1><p class="note">Development only. This page stands in for Log in with PayPal. PayPali receives the PayPal payer ID and whether the account is verified, reduces the ID to a keyed hash and discards it.</p>
<form method="post"><label for="p">PayPal payer ID</label><input id="p" name="payerId" required value="SANDBOXPAYER01" autocomplete="off">
<button name="outcome" value="approve">Share verified account</button><button class="alt" name="outcome" value="unverified">Share unverified account</button><button class="no" name="outcome" value="decline" formnovalidate>Cancel</button></form>
<p style="font-size:.8rem;color:#6a786f">Session ${escHtml(id)}</p></main></body></html>`;
}

/** Shown after PayPal (or the sandbox) hands the owner back to PayPali. */
function kycResultPage(status: string) {
  const msg: Record<string, string> = {
    VERIFIED: 'Your verified PayPal account is linked. PayPali now vouches for you at kyc assurance.',
    DUPLICATE: 'This PayPal account is already linked to another PayPali account. Contact support if that is wrong.',
    REQUIRES_INPUT: 'PayPal did not confirm a verified account. Verify your PayPal account, then try again.',
    CANCELED: 'You cancelled the PayPal sign-in.', PROCESSING: 'Still processing. Refresh in a moment.',
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Identity check</title><style>${PAGE_CSS}</style></head>
<body><main><h1>Identity check</h1><p>Result: <b>${escHtml(status)}</b></p><p>${escHtml(msg[status] ?? 'Something went wrong. Start the check again from PayPali.')}</p><p>You can close this page.</p></main></body></html>`;
}

/** Render a legal markdown document as a plain, escaped HTML page (no markdown parser, no scripts). */
function legalHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>${PAGE_CSS}
main{max-width:720px}pre{white-space:pre-wrap;font:inherit;margin:0}</style></head>
<body><main><pre>${escHtml(body)}</pre></main></body></html>`;
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** PAYPALI_MERCHANTS='[{"id":"agentbazaar","secret":"<>=16 chars>","webhookUrl":"http://127.0.0.1:8787/v1/paypali/webhooks"}]' */
function loadMerchants(): MerchantConfig[] {
  const raw = process.env.PAYPALI_MERCHANTS;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    throw new Error('PAYPALI_MERCHANTS must be a JSON array');
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('REQUEST_TOO_LARGE'); // 1 MB cap
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Coerce a minor-unit field the browser sent as a JS number/string into BigInt.
 *  Anything that isn't a clean integer is passed through untouched so the service
 *  raises its own precise INVALID_* error rather than a generic cast failure. */
function toBig(value: unknown): unknown {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return value;
}

function coerceObjective(objective: any): any {
  if (!objective || typeof objective !== 'object') return objective;
  const out: any = { ...objective };
  if (objective.targetMinor !== undefined) out.targetMinor = toBig(objective.targetMinor);
  return out;
}

function coerceSeed(seed: any): any {
  if (!seed || typeof seed !== 'object') return seed;
  const out: any = { ...seed, amountMinor: toBig(seed.amountMinor) };
  if (typeof seed.expiresAt === 'string') out.expiresAt = new Date(seed.expiresAt);
  return out;
}

function coerceOnboard(body: any): any {
  const policy = body?.policy ?? {};
  return {
    owner: body?.owner,
    agentName: body?.agentName,
    objective: coerceObjective(body?.objective),
    seed: coerceSeed(body?.seed),
    policy: {
      ...policy,
      maxPerTransactionMinor: toBig(policy.maxPerTransactionMinor),
      maxDailyBudgetMinor: toBig(policy.maxDailyBudgetMinor),
      maxMonthlyBudgetMinor: toBig(policy.maxMonthlyBudgetMinor),
      requireHumanApprovalAboveMinor: toBig(policy.requireHumanApprovalAboveMinor),
      allowedRecipients: policy.allowedRecipients ?? [],
      allowedCategories: policy.allowedCategories ?? [],
    },
  };
}

function coerceGenerate(body: any): any {
  return {
    owner: body?.owner,
    objective: coerceObjective(body?.objective),
    seed: coerceSeed(body?.seed),
    agentName: body?.agentName,
    allowedRecipients: body?.allowedRecipients ?? [],
    allowedCategories: body?.allowedCategories ?? [],
  };
}

/** Serializes an agent (with accounts + seeds included) for the UI. */
function agentView(agent: any): unknown {
  return {
    id: agent.id,
    ownerId: agent.ownerId,
    name: agent.name,
    isActive: agent.isActive,
    objectiveType: agent.objectiveType,
    objectiveMandate: agent.objectiveMandate,
    origin: agent.origin,
    createdAt: agent.createdAt,
    accounts: (agent.accounts ?? []).map((a: any) => ({
      currency: a.currency,
      availableMinor: a.availableMinor,
      reservedMinor: a.reservedMinor,
    })),
    seeds: (agent.seeds ?? []).map((s: any) => ({
      id: s.id,
      amountMinor: s.amountMinor,
      currency: s.currency,
      status: s.status,
      fundingCaptureId: s.fundingCaptureId,
    })),
  };
}

async function main(): Promise<void> {
  // Secrets delivered as files (<NAME>_FILE, e.g. Docker/K8s secrets) are copied into their
  // plain variables before anything reads the environment. A plain var always wins.
  const loadedSecrets = hydrateSecrets();
  if (loadedSecrets.length) console.log(`[secrets] loaded from *_FILE: ${loadedSecrets.join(', ')}`);

  const { prisma, mode: dbMode } = await bootDatabase(PROJECT_ROOT);
  console.log(`[db] ${dbMode === 'memory' ? 'in-memory (resets on restart; set PAYPALI_DATA_DIR=.data/db to keep data)' : dbMode}`);
  const onboarding = new OnboardingService(prisma);
  const wallet = new AgentWalletService(prisma);

  // Live PayPal execution: use real PayPal (sandbox/prod) when credentials are
  // present, otherwise the dev gateway so the flow is demoable offline. The
  // browser-checkout driver uses the shared gstack `browse` Chromium when real
  // PayPal is wired, and the dev (always-PAID) driver otherwise.
  const ppClientId = process.env.PAYPAL_CLIENT_ID;
  const ppClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const ppEnv = process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox';
  const liveProvider = ppClientId && ppClientSecret ? `paypal:${ppEnv}` : 'dev';
  const commerce: IPayPalCommerceGateway =
    ppClientId && ppClientSecret
      ? makePayPalCommerceGateway({ clientId: ppClientId, clientSecret: ppClientSecret, environment: ppEnv })
      : new DevPayPalCommerceGateway();
  const checkoutDriver: IBrowserCheckoutDriver =
    ppClientId && ppClientSecret ? new GstackBrowseCheckoutDriver() : new DevBrowserCheckoutDriver();
  const live = new LivePaymentService(prisma, wallet, commerce, checkoutDriver);

  // Bind the money-movement skills to an agent, exactly as an authenticated agent
  // context would: identity comes from the agent record, never from the request
  // body. Returns null if the agent does not exist.
  const skillsFor = async (agentId: string): Promise<AgentSkills | null> => {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return null;
    return new AgentSkills(wallet, { agentId: agent.id, ownerId: agent.ownerId });
  };

  // Funding from PayPal (src/funding): seeds, top-ups, allowances and beneficiary sweeps. With
  // PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET this is PayPal Orders v2 (sandbox unless PAYPAL_ENV=production);
  // without them a dev provider with a local approval page. PAYPALI_ALLOW_DEV_SEEDS=1 lets the demo stack
  // seed its sample agents without a PayPal approval even when PayPal is configured (never in production).
  const publicUrl = (process.env.PAYPALI_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
  // Commercial/legal wrapper: entity + contact fill the templates in legal/*.md, and the URLs
  // are advertised in the Agent Card, provider directory and OAuth metadata.
  const legalEntity = process.env.PAYPALI_LEGAL_ENTITY?.trim() || 'the PayPali operator';
  const legalContact = process.env.PAYPALI_LEGAL_CONTACT?.trim() || 'legal@paypali.example';
  const legal = { entityName: legalEntity, termsUrl: publicUrl + '/legal/terms', privacyUrl: publicUrl + '/legal/privacy', contact: legalContact };
  const portalWebhookSecret = process.env.PAYPALI_PORTAL_WEBHOOK_SECRET ?? '';
  const funding = new FundingService(prisma, wallet, fundingProviderFromEnv(publicUrl), live, {
    publicUrl, allowDevSeeds: process.env.PAYPALI_ALLOW_DEV_SEEDS === '1' && process.env.NODE_ENV !== 'production',
  });
  const fundingRoutes = createFundingRoutes({ prisma, funding });
  const fundingTimer = setInterval(() => {
    funding.runDueAllowances().then(() => funding.runDueSweeps()).catch((e) => console.error('[funding] allowance/sweep run failed:', e));
  }, Number(process.env.PAYPALI_FUNDING_INTERVAL_MS ?? 60_000));
  fundingTimer.unref?.();

  // Drain seed-funding jobs in-process so agents actually fund while you watch.
  const worker = new SeedFundingWorker(prisma, funding.seedGateway(new DevFundingGateway()), {
    pollIntervalMs: 200,
    leaseDurationMs: 10_000,
    retryBaseMs: 500,
    maxAttempts: 5,
  });
  const workerAbort = new AbortController();
  void worker.run(workerAbort.signal);

  // Agent Development: knowledge / skills / capabilities / memory / score.
  // Score bonds are real wallet holds: PAYPALI_BOND_MINOR_PER_POINT minor units per point.
  const agentdev = new AgentDevService(prisma, wallet, {
    bondMinorPerPoint: BigInt(process.env.PAYPALI_BOND_MINOR_PER_POINT ?? '1'),
  });
  const passTimer = setInterval(() => {
    agentdev.passes.runAll().catch((e) => console.error('[agentdev] background pass failed:', e));
  }, Number(process.env.PAYPALI_PASS_INTERVAL_MS ?? 60_000));
  // Merchant Connect: configured merchants (e.g. AgentBazaar) charge agents
  // through owner grants; every charge is a Score-gated bazaar.purchase.
  const merchants = new MerchantService(prisma, wallet, agentdev.score, loadMerchants());
  const webhookTimer = setInterval(() => {
    merchants.deliverDue().catch((e) => console.error('[merchant] webhook delivery failed:', e));
  }, Number(process.env.PAYPALI_WEBHOOK_INTERVAL_MS ?? 1000));
  // Agent Connect + Gas marketplace: external agents (Claude, ChatGPT, Gemini, Grok, Muse, …)
  // reach PayPali through the remote MCP endpoint at PAYPALI_PUBLIC_URL/mcp.
  const portalSecrets = new PortalSecretStore(prisma);
  const gas = new GasService(prisma, wallet, agentdev.score, makePortalRegistry({
    sandbox: process.env.PAYPALI_SERVICE_SANDBOX === '1',
    secretFor: (serviceId) => portalSecrets.resolve(serviceId),
  }));
  // Gas floats with demand (src/market/GasPrice.ts): epochs close on a timer and set the next price.
  const gasOracle = new GasPriceOracle(prisma, gas, gasFloatFromEnv());
  await gasOracle.boot();
  const gasTimer = setInterval(() => { gasOracle.tick().catch((e) => console.error('[gas] price epoch failed:', e)); }, Math.max(1000, Math.min(15_000, Math.floor(gasOracle.cfg.epochMs / 4))));
  gasTimer.unref?.();
  const connect = new AgentConnectService(prisma, agentdev);
  // AgentBazaar bridge: every PayPali agent (built here or connected over MCP) can shop the Bazaar.
  // Needs AGENTBAZAAR_URL, and the Bazaar registered here as a merchant (PAYPALI_MERCHANTS). `npm run stack` wires both.
  const bazaarUrl = process.env.AGENTBAZAAR_URL;
  const bazaarMerchant = process.env.BAZAAR_MERCHANT_ID ?? 'agentbazaar';
  const bazaar = bazaarUrl && merchants.merchant(bazaarMerchant)
    ? new BazaarBridge(prisma, agentdev, merchants, gas, new BazaarClient(bazaarUrl), bazaarMerchant)
    : null;
  // PayPali as an AgentBazaar identity issuer (PAYPALI_IDENTITY_ISSUER_KEY; `npm run stack` generates one).
  // KYC: PAYPALI_KYC_PROVIDER=paypal|sandbox upgrades owners from dev (one account) to kyc (one PayPal-verified account holder).
  const identityIssuer = IdentityIssuer.fromEnv();
  const kyc = identityIssuer
    ? new KycService(prisma, identityIssuer, kycProviderFromEnv(publicUrl), { revocationSinks: bazaarUrl ? [bazaarUrl] : [] })
    : null;
  if (bazaar) bazaar.identity = kyc;
  // Connect PayPali from the Solutions Farm storefront (Buy: a grant bound to the browser key; Sell: identity + payout binding).
  const storefrontLinks = new StorefrontLinkService({ prisma, dev: agentdev, merchants, kyc, merchantId: bazaarMerchant });
  if (kyc) {
    merchants.payoutBindingCheck = async (b, to) =>
      (await kyc.verifyPayoutBinding(b as any, to)) ?? storefrontLinks.payoutBlocked((b as any)?.body?.vendor_pub, to);
    merchants.requirePayoutBinding = process.env.PAYPALI_REQUIRE_PAYOUT_BINDING === '1';
  }
  // Company data agents: answers (not rows) per question type, metered in Gas, escrowed until the
  // dispute window closes, settled in batches. Endpoint calls go through the SSRF-safe fetch
  // (DNS pinned, private ranges refused) unless PAYPALI_ALLOW_INSECURE_DATA_ENDPOINTS=1 (local dev).
  const insecureData = process.env.PAYPALI_ALLOW_INSECURE_DATA_ENDPOINTS === '1';
  const { createSafeFetch } = createRequire(resolve(PROJECT_ROOT, 'package.json'))('./AgentBazaar/safe-fetch.js');
  const dataFetch: DataFetch = insecureData ? (u, init) => fetch(u, init) as any : createSafeFetch({ maxBytes: 512 * 1024 });
  const data = new DataAgentService(prisma, agentdev, wallet, gas, dataFetch, { kyc, issuer: identityIssuer }, {
    allowInsecureEndpoints: insecureData, requireKycSellers: process.env.PAYPALI_DATA_REQUIRE_KYC === '1',
  });
  const dataRoutes = createDataRoutes({ prisma, data });
  const dataTimer = setInterval(() => {
    data.recover().then(() => data.settleDue()).catch((e) => console.error('[data] settlement failed:', e));
  }, Number(process.env.PAYPALI_DATA_SETTLE_INTERVAL_MS ?? 60_000));
  dataTimer.unref?.();
  // Agency: Power of Agency (the holder–agent contract) and the owner's kill switch.
  const agency = new AgencyService({ prisma, score: agentdev.score, connect, bazaar, merchants, data, funding, kyc, issuer: identityIssuer });
  // Skills: agents sell skills to agents, priced in Gas (src/skills). Demo skills (builtin executors) only with dev seeds.
  const devSeeds = process.env.PAYPALI_ALLOW_DEV_SEEDS === '1' && process.env.NODE_ENV !== 'production';
  const partners = (process.env.PAYPALI_PARTNER_PROVIDERS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const skillMarket = new SkillMarket({ prisma, wallet, dev: agentdev, gas, fetchFn: dataFetch, allowBuiltin: devSeeds, allowInsecureEndpoints: insecureData, partners });
  registerDemoSkills(skillMarket);
  agency.skills = skillMarket;
  if (devSeeds && process.env.PAYPALI_DEMO_SKILLS !== '0') {
    void seedDemoSkills(skillMarket, {
      agentFor: async (email, name) => {
        const o = await prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
        const a = (await prisma.agent.findFirst({ where: { ownerId: o.id, name } })) ?? (await prisma.agent.create({ data: { ownerId: o.id, name, objectiveType: 'GROWTH', objectiveMandate: `Sell ${name}'s skills to other agents (demo).` } }));
        await wallet.ensureAccount(a.id, 'USD');
        return { ownerId: o.id, agentId: a.id };
      },
      signPoa: (ownerId, agentId) => agency.sign(ownerId, agentId),
    }).then(() => console.log('  Demo skills: Northwind catalog search, Scene match, Find an episode'), (e) => console.error('[skills] demo seed failed:', e));
  }
  const enforceAgency = process.env.PAYPALI_REQUIRE_POWER_OF_AGENCY === '1';
  if (enforceAgency) agency.enforce();
  const agencyRoutes = createAgencyRoutes({ prisma, agency, enforced: enforceAgency });
  const adminToken = process.env.PAYPALI_ADMIN_TOKEN ?? '';
  const connectRoutes = createConnectRoutes({
    prisma, connect, dev: agentdev, wallet, gas, bazaar, data, agency, skills: skillMarket, publicUrl,
    // OAuth consent (Claude, ChatGPT, Grok… apps) signs the owner in with their PayPali session. Email-only
    // sign-in on the consent page is a dev convenience, never offered when sessions are required.
    sessionOwner: (r) => sessions.ownerFor(r),
    devEmailConsent: process.env.PAYPALI_REQUIRE_SESSION !== '1' && process.env.NODE_ENV !== 'production',
    allowedOrigins: (process.env.PAYPALI_MCP_ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    legal,
    rateLimits: { mcpPerMin: Number(process.env.PAYPALI_MCP_RATE_PER_MIN ?? 240), oauthPerMin: Number(process.env.PAYPALI_OAUTH_RATE_PER_MIN ?? 40) },
  });
  const ownerOf = async (agentId: string): Promise<string> => {
    const a = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!a) throw new Error('AGENT_NOT_FOUND');
    return a.ownerId;
  };

  // Owner sign-in shared by Onboarding, Dashboard and Marketplace (src/auth/SessionService.ts).
  const sessions = new SessionService(prisma, { publicUrl });
  const skillRoutes = createSkillRoutes({ prisma, market: skillMarket, bazaar, gasPrice: gasOracle, partners, sessionOwner: (r) => sessions.ownerFor(r), requireSession: process.env.PAYPALI_REQUIRE_SESSION === '1' });
  const linkRoutes = createStorefrontLinkRoutes({
    prisma, links: storefrontLinks, sessionOwner: (r) => sessions.ownerFor(r), publicUrl,
    bazaarPublicUrl: bazaar ? (process.env.AGENTBAZAAR_PUBLIC_URL || bazaarUrl || null) : null,
  });
  // PAYPALI_REQUIRE_SESSION=1: owner and agent routes need a signed-in owner who owns them. Off by default so the
  // dev harness, e2e scripts and MCP clients keep working unchanged; turn it on for any shared deployment.
  const requireSession = process.env.PAYPALI_REQUIRE_SESSION === '1';
  const OPEN_AGENT_ROUTES = /^\/api\/agents\/[^/]+\/(bazaar\/(buy|run|report|resume)|orders\/)/;   // also reachable as agent acts
  async function sessionGuard(req: IncomingMessage, path: string, method: string): Promise<{ status: number; error: string } | null> {
    let m: RegExpMatchArray | null;
    const needOwner = async (ownerId: string | null) => {
      const me = await sessions.ownerFor(req);
      if (!me) return { status: 401, error: 'SIGN_IN_REQUIRED' };
      if (ownerId && me.id !== ownerId) return { status: 403, error: 'NOT_YOUR_ACCOUNT' };
      return null;
    };
    if ((m = path.match(/^\/api\/owners\/([^/]+)(\/|$)/))) return needOwner(decodeURIComponent(m[1]));
    if (method === 'GET' && path === '/api/agents') return needOwner(null);
    if ((m = path.match(/^\/api\/(?:agents|agentdev\/agents)\/([^/]+)(\/|$)/)) && !OPEN_AGENT_ROUTES.test(path)) {
      const a = await prisma.agent.findUnique({ where: { id: decodeURIComponent(m[1]) } });
      return needOwner(a ? a.ownerId : '__none__');
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // --- owner sign-in --------------------------------------------------
      if (method === 'GET' && (path === '/login' || path === '/login.html')) {
        const me = await sessions.ownerFor(req);
        if (me && !url.searchParams.has('switch')) { res.writeHead(303, { location: safeNext(url.searchParams.get('next')) }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await readFile(LOGIN_PATH, 'utf8'));
        return;
      }
      if (method === 'POST' && path === '/api/session/login') {
        const body = (await readBody(req)) as any;
        // Sign-in links open on the host the person is actually using (localhost vs 127.0.0.1 are different cookie jars).
        sendJson(res, 200, await sessions.requestLink(body?.email, body?.next, localOrigin(req)));
        return;
      }
      if (method === 'GET' && path === '/auth/verify') {
        try {
          const v = await sessions.verifyLink(url.searchParams.get('token'));
          // Mark the landing page so it can tell the person if their browser threw the cookie away.
          const landing = v.next.includes('#') ? v.next : v.next + '#pp-signed-in';
          res.writeHead(303, { location: landing, 'set-cookie': v.cookie, 'cache-control': 'no-store' });
          res.end();
        } catch {
          res.writeHead(303, { location: '/login?error=link', 'cache-control': 'no-store' });
          res.end();
        }
        return;
      }
      if (method === 'GET' && path === '/api/session') {
        const me = await sessions.ownerFor(req);
        if (!me) { sendJson(res, 200, { signedIn: false }); return; }
        const agents = await prisma.agent.findMany({ where: { ownerId: me.id }, orderBy: { createdAt: 'desc' }, include: { accounts: true } });
        sendJson(res, 200, { signedIn: true, owner: me, agents: agents.map((a) => ({
          id: a.id, name: a.name, isActive: a.isActive, objectiveType: a.objectiveType, createdAt: a.createdAt,
          accounts: a.accounts.map((x) => ({ currency: x.currency, availableMinor: x.availableMinor })),
        })) });
        return;
      }
      if (method === 'POST' && path === '/api/session/logout') {
        const out = await sessions.logout(req);
        sendJson(res, 200, { signedIn: false }, { 'set-cookie': out.cookie });
        return;
      }
      if (requireSession) {
        const deny = await sessionGuard(req, path, method);
        if (deny) { sendJson(res, deny.status, { error: deny.error }); return; }
      }

      if (await connectRoutes(req, res, url)) return;
      if (await dataRoutes(req, res, url)) return;
      if (await fundingRoutes(req, res, url)) return;
      if (await agencyRoutes(req, res, url)) return;
      if (await linkRoutes(req, res, url)) return;
      if (await skillRoutes(req, res, url)) return;

      // --- pages ----------------------------------------------------------
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(PAGE_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });   // never serve a stale page after an update
        res.end(html);
        return;
      }
      if (method === 'GET' && (path === '/marketplace' || path === '/marketplace.html')) {
        const html = await readFile(MARKETPLACE_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });   // never serve a stale page after an update
        res.end(html);
        return;
      }
      if (method === 'GET' && (path === '/dashboard' || path === '/dashboard.html')) {
        const html = await readFile(DASHBOARD_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });   // never serve a stale page after an update
        res.end(html);
        return;
      }

      // --- legal/commercial wrapper: Terms of Service + Privacy Policy ----
      if (method === 'GET' && (path === '/legal/terms' || path === '/legal/privacy')) {
        const terms = path === '/legal/terms';
        let md: string;
        try { md = await readFile(terms ? TERMS_PATH : PRIVACY_PATH, 'utf8'); } catch { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
        const filled = md
          .replace(/\{\{ENTITY\}\}/g, legalEntity)
          .replace(/\{\{CONTACT\}\}/g, legalContact)
          .replace(/\{\{PUBLIC_URL\}\}/g, publicUrl)
          .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10));
        if (String(req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(legalHtml(terms ? 'PayPali Terms of Service' : 'PayPali Privacy Policy', filled));
        } else {
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
          res.end(filled);
        }
        return;
      }

      // --- onboard / generate --------------------------------------------
      if (method === 'POST' && (path === '/api/generate' || path === '/api/onboard')) {
        const body = await readBody(req);
        const email = String((body as any)?.owner?.email ?? '').trim().toLowerCase();
        const existed = !!email && !!(await prisma.owner.findUnique({ where: { email } }));
        if (existed && requireSession) {
          const me = await sessions.ownerFor(req);
          if (!me || me.email !== email) { sendJson(res, 401, { error: 'SIGN_IN_REQUIRED', hint: 'This email already has a PayPali account. Sign in first.' }); return; }
        }
        const input: any = path === '/api/generate' ? coerceGenerate(body) : coerceOnboard(body);
        // The owner sets the agent's Gas rate card when setting it up (what it charges to act for other agents).
        const rc = (body as any)?.rateCard;
        if (rc !== undefined && rc !== null) {
          const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000;
          if (typeof rc !== 'object' || !ok(rc.actFeeGas) || !ok(rc.maxFeeGas) || rc.actFeeGas > rc.maxFeeGas) { sendJson(res, 400, { error: 'INVALID_RATE_CARD', hint: '{actFeeGas, maxFeeGas}: whole Gas, fee at most the maximum' }); return; }
        }
        // Live PayPal: the seed must be an order the owner approved at PayPal, for exactly this amount.
        const seedProblem = input.seed ? await funding.checkSeedReference(String(input.seed.fundingSourceReference ?? ''), input.seed.amountMinor, input.seed.currency) : null;
        if (seedProblem) { sendJson(res, 400, { error: seedProblem }); return; }
        const result = path === '/api/generate' ? await onboarding.generateAgent(input) : await onboarding.onboardAgent(input);
        // A brand-new owner is signed in now. An existing email is never signed in by onboarding (that would let
        // anyone take over an account by typing its email): it gets signInRequired and uses an email sign-in link.
        const s = await sessions.afterOnboarding(req, result.ownerId, existed);
        if (rc) await skillMarket.setRateCard(result.agentId, { maxFeeGas: rc.maxFeeGas, actFeeGas: rc.actFeeGas }, { ownerId: result.ownerId });
        // Bring an agent the owner already uses (Claude, ChatGPT, Grok, DeepSeek…). Only for a brand-new owner
        // signed in just now: a token must never be handed to someone who merely typed an existing email.
        let connection: Record<string, unknown> | null = null;
        const want = (body as any)?.connect;
        if (want && typeof want === 'object' && want.surface) {
          if (!s.signedIn) connection = { deferred: true, reason: 'SIGN_IN_TO_CONNECT' };
          else {
            try {
              const c = await connect.connectExisting(result.ownerId, result.agentId, { surface: want.surface, scopes: Array.isArray(want.scopes) ? want.scopes : undefined, allowRecurring: want.allowRecurring === true, label: want.label });
              const mcpUrl = publicUrl + '/mcp';
              connection = {
                mode: c.mode, provider: c.provider, surface: c.surface, connectionId: c.connection?.id ?? null, token: c.token, mcpUrl,
                publicUrlReachable: isPublicUrl(publicUrl), setup: setupFor(c.provider, mcpUrl, c.token ?? undefined).find((x) => x.surface === c.surface) ?? null,
              };
            } catch (e) { connection = { error: (e as Error).message }; }
          }
        }
        sendJson(res, 200, { ...result, signedIn: s.signedIn, signInRequired: !s.signedIn, connection }, s.cookie ? { 'set-cookie': s.cookie } : {});
        return;
      }

      // --- agent skills: receive / spend / send --------------------------
      const skillMatch = path.match(/^\/api\/agents\/([^/]+)\/(receive|spend|send)$/);
      if (method === 'POST' && skillMatch) {
        const agentId = decodeURIComponent(skillMatch[1]);
        const op = skillMatch[2];
        const skills = await skillsFor(agentId);
        if (!skills) {
          sendJson(res, 404, { error: 'AGENT_NOT_FOUND' });
          return;
        }
        const body = (await readBody(req)) as any;
        // Each manual action is its own movement unless the caller pins a key
        // (pin the same key twice to see idempotent replay).
        const idempotencyKey =
          typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
            ? body.idempotencyKey.trim()
            : randomUUID();

        if (op === 'receive') {
          // A credit from nowhere is a dev convenience. With PayPal configured, money only arrives through
          // PayPal (seed, top-up, allowance) or from another agent.
          if (funding.isLive && process.env.PAYPALI_ALLOW_DEV_SEEDS !== '1') { sendJson(res, 403, { error: 'FUND_THROUGH_PAYPAL', hint: 'POST /api/agents/:id/funding/orders' }); return; }
          const result = await skills.receive({
            amountMinor: toBig(body?.amountMinor) as bigint,
            currency: body?.currency,
            idempotencyKey,
            type: body?.type,
          });
          sendJson(res, 200, { ...result, idempotencyKey });
          return;
        }
        if (op === 'spend') {
          const result = await skills.spend({
            amountMinor: toBig(body?.amountMinor) as bigint,
            currency: body?.currency,
            idempotencyKey,
          });
          sendJson(res, 200, { ...result, idempotencyKey });
          return;
        }
        // send — validate the recipient exists here so a typo'd id returns a
        // clean 400 instead of a raw foreign-key error from the wallet.
        if (typeof body?.toAgentId === 'string' && body.toAgentId.trim()) {
          const recipient = await prisma.agent.findUnique({
            where: { id: body.toAgentId.trim() },
          });
          if (!recipient) {
            sendJson(res, 400, { error: 'RECIPIENT_NOT_FOUND' });
            return;
          }
        }
        const result = await skills.send({
          toAgentId: body?.toAgentId,
          amountMinor: toBig(body?.amountMinor) as bigint,
          currency: body?.currency,
          idempotencyKey,
        });
        sendJson(res, 200, { ...result, idempotencyKey });
        return;
      }

      // --- live PayPal transactions: pay / checkout / payout / topup -----
      const liveMatch = path.match(/^\/api\/agents\/([^/]+)\/(pay|checkout|payout|topup)$/);
      if (method === 'POST' && liveMatch) {
        const agentId = decodeURIComponent(liveMatch[1]);
        const op = liveMatch[2];
        const body = (await readBody(req)) as any;
        const idempotencyKey =
          typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
            ? body.idempotencyKey.trim()
            : randomUUID();
        const amountMinor = toBig(body?.amountMinor) as bigint;
        const currency = body?.currency;

        let result;
        if (op === 'pay') {
          result = await live.pay({
            agentId, amountMinor, currency, idempotencyKey,
            payeeReference: body?.payeeReference ?? body?.payee ?? '',
            description: body?.description ?? 'agent purchase',
            merchantCategoryCode: body?.merchantCategoryCode,
          });
        } else if (op === 'checkout') {
          result = await live.checkoutOnSite({
            agentId, amountMinor, currency, idempotencyKey,
            siteUrl: body?.siteUrl ?? '',
            instructions: body?.instructions,
          });
        } else if (op === 'payout') {
          result = await live.payoutExternal({
            agentId, amountMinor, currency, idempotencyKey,
            receiver: body?.receiver ?? '',
            note: body?.note ?? 'agent payout',
          });
        } else {
          result = await live.receiveInbound({
            agentId, amountMinor, currency, idempotencyKey,
            orderId: body?.orderId ?? '',
          });
        }
        sendJson(res, 200, { ...result, provider: liveProvider });
        return;
      }

      // --- Merchant Connect: merchant API (HMAC-authenticated) ------------
      if (path.startsWith('/api/merchant/')) {
        const raw = await readRaw(req);
        const merchantId = String(req.headers['x-paypali-merchant'] ?? '');
        const m = merchants.merchant(merchantId);
        const pathWithQuery = url.pathname + url.search;
        const verdict = m
          ? verifyRequest(m.secret, { ts: req.headers['x-paypali-timestamp'] as string, sig: req.headers['x-paypali-signature'] as string }, method, pathWithQuery, raw)
          : 'UNKNOWN_MERCHANT';
        if (verdict !== 'OK') {
          sendJson(res, 401, { error: verdict });
          return;
        }
        let body: any = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { sendJson(res, 400, { error: 'INVALID_JSON' }); return; }
        let mm: RegExpMatchArray | null;

        if (method === 'GET' && (mm = path.match(/^\/api\/merchant\/grants\/([^/]+)$/))) {
          sendJson(res, 200, await merchants.getGrant(merchantId, decodeURIComponent(mm[1])));
          return;
        }
        if (method === 'POST' && path === '/api/merchant/charges') {
          const r = await merchants.charge(merchantId, {
            grantId: body?.grantId, amountMinor: toBig(body?.amountMinor) as bigint, currency: body?.currency,
            idempotencyKey: body?.idempotencyKey, reference: body?.reference,
            score: { intentKey: body?.score?.intentKey, confidencePct: body?.score?.confidencePct, ttlMs: body?.score?.ttlMs },
          });
          sendJson(res, r.status === 'PAID' ? 200 : 402, r);
          return;
        }
        if (method === 'POST' && (mm = path.match(/^\/api\/merchant\/charges\/([^/]+)\/outcome$/))) {
          sendJson(res, 200, await merchants.reportOutcome(merchantId, decodeURIComponent(mm[1]), { success: body?.success, evidence: body?.evidence }));
          return;
        }
        if (method === 'POST' && (mm = path.match(/^\/api\/merchant\/charges\/([^/]+)\/refund$/))) {
          sendJson(res, 200, await merchants.refund(merchantId, decodeURIComponent(mm[1]), body?.reason));
          return;
        }
        if (method === 'POST' && path === '/api/merchant/payouts') {
          sendJson(res, 200, await merchants.payout(merchantId, {
            toAgentId: body?.toAgentId, amountMinor: toBig(body?.amountMinor) as bigint, currency: body?.currency,
            idempotencyKey: body?.idempotencyKey, reference: body?.reference, binding: body?.binding,
          }));
          return;
        }
        if (method === 'GET' && path === '/api/merchant/balance') {
          sendJson(res, 200, await merchants.balance(merchantId, url.searchParams.get('currency') ?? 'USD'));
          return;
        }
        sendJson(res, 404, { error: 'NOT_FOUND', path });
        return;
      }

      // --- demo/ops: close a data agent's dispute windows early and settle (admin token, never in production) ---
      {
        const secretRoute = path.match(/^\/api\/admin\/portals\/([a-z0-9-]+)\/secret$/);
        if (secretRoute && ['GET', 'PUT', 'DELETE'].includes(method)) {
          const tok = String(req.headers['x-admin-token'] ?? '');
          if (!adminToken || tok.length !== adminToken.length || !timingSafeEqual(Buffer.from(tok), Buffer.from(adminToken))) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
          const serviceId = decodeURIComponent(secretRoute[1]);
          if (!findService(serviceId)) { sendJson(res, 404, { error: 'SERVICE_NOT_FOUND' }); return; }
          if (method === 'GET') {
            sendJson(res, 200, await portalSecrets.status(serviceId));
            return;
          }
          if (method === 'DELETE') {
            await portalSecrets.remove(serviceId);
            sendJson(res, 200, { serviceId, configured: false });
            return;
          }
          const body = await readBody(req);
          const secret = body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).secret
            : undefined;
          if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret, 'utf8') > 16_384) {
            sendJson(res, 400, { error: 'INVALID_PORTAL_SECRET' });
            return;
          }
          const saved = await portalSecrets.set(serviceId, secret);
          sendJson(res, 200, { serviceId, configured: true, createdAt: saved.createdAt, updatedAt: saved.updatedAt });
          return;
        }
        const mm = path.match(/^\/api\/admin\/data-agents\/([a-z0-9-]+)\/settle-now$/);
        if (method === 'POST' && mm) {
          const tok = String(req.headers['x-admin-token'] ?? '');
          if (process.env.NODE_ENV === 'production' || !adminToken || tok.length !== adminToken.length || !timingSafeEqual(Buffer.from(tok), Buffer.from(adminToken))) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
          sendJson(res, 200, await data.settleEarly(mm[1]));
          return;
        }
      }

      // --- provider confirmation webhook: settle a PENDING_PROVIDER Gas order later ---
      // A service's Agent Portal calls this once it has (or hasn't) fulfilled an order
      // that was left PENDING. HMAC-signed with PAYPALI_PORTAL_WEBHOOK_SECRET (same scheme
      // as Merchant Connect). Idempotent: re-delivery after settlement is a no-op.
      if (method === 'POST' && path === '/api/portals/confirm') {
        const raw = await readRaw(req);
        const verdict = portalWebhookSecret
          ? verifyRequest(portalWebhookSecret, { ts: req.headers['x-paypali-timestamp'] as string, sig: req.headers['x-paypali-signature'] as string }, method, url.pathname + url.search, raw)
          : 'NOT_CONFIGURED';
        if (verdict !== 'OK') { sendJson(res, verdict === 'NOT_CONFIGURED' ? 503 : 401, { error: verdict === 'NOT_CONFIGURED' ? 'PORTAL_WEBHOOK_NOT_CONFIGURED' : verdict }); return; }
        let body: any = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { sendJson(res, 400, { error: 'INVALID_JSON' }); return; }
        if (typeof body.orderId !== 'string' || !body.orderId) { sendJson(res, 400, { error: 'MISSING_ORDER_ID' }); return; }
        sendJson(res, 200, await gas.confirmOrder(body.orderId, {
          success: body.success === true,
          providerRef: typeof body.providerRef === 'string' ? body.providerRef : undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        }));
        return;
      }

      // --- Merchant Connect: owner grants (dev harness: unauthenticated) --
      // --- Identity authority for AgentBazaar: credentials, KYC, payout bindings, revocations ---
      if (path === '/.well-known/paypali-identity-issuer' || path === '/.well-known/paypali-identity-revocations'
        || path === '/api/kyc/paypal/callback' || path.startsWith('/kyc/sandbox/') || path.startsWith('/api/admin/identity/')
        || /^\/api\/owners\/[^/]+\/(identity-credentials|kyc|kyc\/sessions|payout-bindings)$/.test(path)) {
        if (!kyc || !identityIssuer) { sendJson(res, 404, { error: 'IDENTITY_ISSUER_NOT_CONFIGURED' }); return; }
        let mm: RegExpMatchArray | null;
        if (method === 'GET' && path === '/.well-known/paypali-identity-issuer') {
          sendJson(res, 200, identityIssuer.descriptor({ revocations_url: `${publicUrl}/.well-known/paypali-identity-revocations`, kyc_provider: kyc.provider?.id ?? null }));
          return;
        }
        if (method === 'GET' && path === '/.well-known/paypali-identity-revocations') {
          sendJson(res, 200, await kyc.revocationFeed(Number(url.searchParams.get('since')) || undefined));
          return;
        }
        // Log in with PayPal returns here (?code&state, or ?error&state). `state` is the single-use session id.
        if (method === 'GET' && path === '/api/kyc/paypal/callback') {
          const q = Object.fromEntries(url.searchParams) as Record<string, string>;
          let out: { status: string } = { status: 'FAILED' };
          try { if (q.state) out = await kyc.complete(q.state, { code: q.code, error: q.error }); }
          catch (e) { out = { status: (e as Error).message === 'KYC_SESSION_NOT_FOUND' ? 'UNKNOWN_SESSION' : 'FAILED' }; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(kycResultPage(out.status));
          return;
        }
        // Dev/test sandbox: a PayPali page plays Log in with PayPal.
        if ((mm = path.match(/^\/kyc\/sandbox\/(ksb_[0-9a-f]+)$/))) {
          if (!(kyc.provider instanceof SandboxKycProvider) || !kyc.provider.has(mm[1])) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
          if (method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(sandboxKycPage(mm[1])); return; }
          if (method === 'POST') {
            const raw = await readRaw(req), json = (req.headers['content-type'] ?? '').includes('application/json');
            const f = json ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
            const out = await kyc.complete(mm[1], { outcome: String(f.outcome ?? ''), payerId: String(f.payerId ?? '') });
            if (json) { sendJson(res, 200, out); return; }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });   // never serve a stale page after an update
            res.end(kycResultPage(out.status));
            return;
          }
        }
        if (method === 'POST' && (mm = path.match(/^\/api\/admin\/identity\/([^/]+)\/revoke$/))) {
          const tok = String(req.headers['x-admin-token'] ?? '');
          if (!adminToken || tok.length !== adminToken.length || !timingSafeEqual(Buffer.from(tok), Buffer.from(adminToken))) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
          const body = (await readBody(req)) as any;
          sendJson(res, 200, await kyc.revoke(decodeURIComponent(mm[1]), String(body?.reason ?? '')));
          return;
        }
        // DEV SERVER NOTE: owner routes are unauthenticated like the rest of this harness; production binds the owner to a session.
        if ((mm = path.match(/^\/api\/owners\/([^/]+)\/(identity-credentials|kyc|kyc\/sessions|payout-bindings)$/))) {
          const ownerId = decodeURIComponent(mm[1]), op = mm[2];
          if (method === 'GET' && op === 'kyc') { sendJson(res, 200, await kyc.status(ownerId)); return; }
          if (method === 'POST') {
            const body = (await readBody(req)) as any;
            if (op === 'kyc/sessions') { sendJson(res, 200, await kyc.start(ownerId)); return; }
            if (op === 'identity-credentials') { sendJson(res, 200, { credential: await kyc.credentialFor(ownerId, String(body?.principalPub ?? ''), { ttlMs: Number(body?.ttlMs) || undefined }) }); return; }
            if (op === 'payout-bindings') { sendJson(res, 200, { binding: await kyc.payoutBinding(ownerId, String(body?.agentId ?? ''), String(body?.vendorPub ?? '')) }); return; }
          }
        }
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const grantsMatch = path.match(/^\/api\/agents\/([^/]+)\/merchant-grants$/);
      if (grantsMatch) {
        const agentId = decodeURIComponent(grantsMatch[1]);
        if (method === 'GET') {
          sendJson(res, 200, { grants: await merchants.listGrants(agentId) });
          return;
        }
        if (method === 'POST') {
          const body = (await readBody(req)) as any;
          sendJson(res, 200, await merchants.createGrant(await ownerOf(agentId), agentId, {
            merchantId: body?.merchantId, maxMinor: toBig(body?.maxMinor) as bigint, currency: body?.currency ?? 'USD',
            expiresAt: body?.expiresAt ? new Date(body.expiresAt) : undefined,
          }));
          return;
        }
      }
      const revokeMatch = path.match(/^\/api\/merchant-grants\/([^/]+)\/revoke$/);
      if (method === 'POST' && revokeMatch) {
        const grantId = decodeURIComponent(revokeMatch[1]);
        const g = await prisma.merchantGrant.findUnique({ where: { id: grantId } });
        if (!g) { sendJson(res, 404, { error: 'GRANT_NOT_FOUND' }); return; }
        sendJson(res, 200, await merchants.revokeGrant(g.ownerId, grantId));
        return;
      }

      // --- Agent Development ----------------------------------------------
      // DEV SERVER NOTE: like the rest of this harness these routes are not
      // authenticated; owner identity is taken from the agent record (or the
      // body for owner-level objects). Production must bind ownerId to a session.
      if (path.startsWith('/api/agentdev/')) {
        const body = method === 'GET' ? {} : ((await readBody(req)) as any);
        let m: RegExpMatchArray | null;

        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/develop$/))) {
          const agentId = decodeURIComponent(m[1]);
          sendJson(res, 200, await agentdev.develop(await ownerOf(agentId), agentId, {
            initialPoints: body?.initialPoints, floor: body?.floor,
          }));
          return;
        }
        if (method === 'GET' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/context$/))) {
          sendJson(res, 200, await agentdev.context(decodeURIComponent(m[1]), {
            query: url.searchParams.get('q') ?? undefined,
            tags: url.searchParams.getAll('tag'),
            limit: Number(url.searchParams.get('limit') ?? 20),
          }));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/quote$/))) {
          const agentId = decodeURIComponent(m[1]);
          sendJson(res, 200, await agentdev.score.quote({
            agentId, capability: body?.capability, intentKey: body?.intentKey, confidencePct: body?.confidencePct,
            skillId: body?.skillId, amountMinor: body?.amountMinor !== undefined ? (toBig(body.amountMinor) as bigint) : undefined,
            currency: body?.currency,
          }));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/capabilities$/))) {
          const agentId = decodeURIComponent(m[1]);
          sendJson(res, 200, await agentdev.skills.grantCapability(await ownerOf(agentId), agentId, body?.capability, body?.maxRisk,
            body?.expiresAt ? new Date(body.expiresAt) : undefined));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/capabilities\/([^/]+)\/revoke$/))) {
          const agentId = decodeURIComponent(m[1]);
          sendJson(res, 200, await agentdev.skills.revokeCapability(await ownerOf(agentId), agentId, decodeURIComponent(m[2])));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/(skills|modules)$/))) {
          const agentId = decodeURIComponent(m[1]);
          const ownerId = await ownerOf(agentId);
          sendJson(res, 200, m[2] === 'skills'
            ? await agentdev.skills.bindSkill(ownerId, agentId, body?.skillId)
            : await agentdev.knowledge.bindModule(ownerId, agentId, body?.moduleId));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/memory$/))) {
          const agentId = decodeURIComponent(m[1]);
          sendJson(res, 200, await agentdev.memory.setOwnerMemory(await ownerOf(agentId), agentId, body?.key, body?.content, body?.kind));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/agents\/([^/]+)\/facts\/propose$/))) {
          sendJson(res, 200, await agentdev.knowledge.proposeFact(decodeURIComponent(m[1]), body?.moduleId, body));
          return;
        }
        if (method === 'POST' && path === '/api/agentdev/modules') {
          sendJson(res, 200, await agentdev.knowledge.createModule(body?.ownerId, body?.name, body?.description));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/modules\/([^/]+)\/facts$/))) {
          sendJson(res, 200, await agentdev.knowledge.addFact(body?.ownerId, decodeURIComponent(m[1]), {
            statement: body?.statement, source: body?.source, tags: body?.tags,
            expiresAt: body?.expiresAt ? new Date(body.expiresAt) : undefined,
          }));
          return;
        }
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/facts\/([^/]+)\/(approve|supersede|retire)$/))) {
          const factId = decodeURIComponent(m[1]);
          const r = m[2] === 'approve' ? await agentdev.knowledge.approveFact(body?.ownerId, factId)
            : m[2] === 'retire' ? await agentdev.knowledge.retireFact(body?.ownerId, factId)
            : await agentdev.knowledge.supersedeFact(body?.ownerId, factId, { statement: body?.statement, source: body?.source, tags: body?.tags });
          sendJson(res, 200, r);
          return;
        }
        if (method === 'POST' && path === '/api/agentdev/skills') {
          sendJson(res, 200, await agentdev.skills.defineSkill(body?.ownerId, body));
          return;
        }
        // Reconciliation settles a stake left OPEN by an ambiguous result.
        if (method === 'POST' && (m = path.match(/^\/api\/agentdev\/stakes\/([^/]+)\/settle$/))) {
          sendJson(res, 200, await agentdev.score.settle(decodeURIComponent(m[1]), { success: body?.success, evidence: body?.evidence }));
          return;
        }
        if (method === 'POST' && path === '/api/agentdev/passes/run') {
          sendJson(res, 200, await agentdev.passes.runAll());
          return;
        }
        sendJson(res, 404, { error: 'NOT_FOUND', path });
        return;
      }

      // --- scored live transactions: the score gate in front of real money -
      const scoredMatch = path.match(/^\/api\/agents\/([^/]+)\/scored\/(pay|checkout|payout)$/);
      if (method === 'POST' && scoredMatch) {
        const agentId = decodeURIComponent(scoredMatch[1]);
        const op = scoredMatch[2];
        const body = (await readBody(req)) as any;
        const amountMinor = toBig(body?.amountMinor) as bigint;
        const currency = body?.currency ?? 'USD';
        const idempotencyKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : randomUUID();
        const run = await agentdev.executor.run(
          { agentId, capability: `wallet.${op}`, intentKey: body?.intentKey, confidencePct: body?.confidencePct,
            skillId: body?.skillId, amountMinor, currency },
          () => op === 'pay'
            ? live.pay({ agentId, amountMinor, currency, idempotencyKey, payeeReference: body?.payeeReference ?? '',
                description: body?.description ?? 'agent purchase', merchantCategoryCode: body?.merchantCategoryCode })
            : op === 'checkout'
              ? live.checkoutOnSite({ agentId, amountMinor, currency, idempotencyKey, siteUrl: body?.siteUrl ?? '', instructions: body?.instructions })
              : live.payoutExternal({ agentId, amountMinor, currency, idempotencyKey, receiver: body?.receiver ?? '', note: body?.note ?? 'agent payout' }),
          judgeLive
        );
        sendJson(res, run.allowed ? 200 : 403, { ...run, provider: liveProvider });
        return;
      }

      // --- agent snapshot (lets the UI watch the seed fund) --------------
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (method === 'GET' && agentMatch) {
        const agent = await prisma.agent.findUnique({
          where: { id: decodeURIComponent(agentMatch[1]) },
          include: { accounts: true, seeds: true },
        });
        if (!agent) {
          sendJson(res, 404, { error: 'AGENT_NOT_FOUND' });
          return;
        }
        sendJson(res, 200, agentView(agent));
        return;
      }

      // --- owner account (the dashboard's data source) -------------------
      const ownerMatch = path.match(/^\/api\/owners\/([^/]+)$/);
      if (method === 'GET' && ownerMatch) {
        const owner = await prisma.owner.findUnique({
          where: { id: decodeURIComponent(ownerMatch[1]) },
          include: {
            agents: {
              orderBy: { createdAt: 'desc' },
              include: { accounts: true, seeds: true },
            },
          },
        });
        if (!owner) {
          sendJson(res, 404, { error: 'OWNER_NOT_FOUND' });
          return;
        }
        sendJson(res, 200, {
          ownerId: owner.id,
          email: owner.email,
          createdAt: owner.createdAt,
          agents: owner.agents.map(agentView),
        });
        return;
      }

      // --- recent agents (handy for manual testing) ----------------------
      if (method === 'GET' && path === '/api/agents') {
        const me = requireSession ? await sessions.ownerFor(req) : null;
        const agents = await prisma.agent.findMany({
          ...(me ? { where: { ownerId: me.id } } : {}),
          orderBy: { createdAt: 'desc' },
          take: 25,
          include: { owner: true, accounts: true },
        });
        sendJson(res, 200, {
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            ownerEmail: a.owner.email,
            objectiveType: a.objectiveType,
            isActive: a.isActive,
            createdAt: a.createdAt,
            accounts: a.accounts.map((acc) => ({
              currency: acc.currency,
              availableMinor: acc.availableMinor,
            })),
          })),
        });
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND', path });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'INTERNAL_ERROR';
      // Domain validation errors from the service are the caller's fault (400);
      // everything else is a server fault (500).
      const isValidation = /^[A-Z_]+(:[\w.-]+)*$/.test(message);
      sendJson(res, isValidation ? 400 : 500, { error: message });
    }
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  PayPali dev server → http://localhost:${PORT}\n`);
    // eslint-disable-next-line no-console
    console.log('  In-process PGlite DB (fresh each start) · dev seed funding is auto-captured.');
    // eslint-disable-next-line no-console
    console.log(`  AgentBazaar bridge: ${bazaar ? bazaarUrl + ' (merchant ' + bazaarMerchant + ')' : 'off (set AGENTBAZAAR_URL + PAYPALI_MERCHANTS, or npm run stack)'}`);
    // eslint-disable-next-line no-console
    console.log(`  Remote MCP for external agents: ${publicUrl}/mcp` + (process.env.PAYPALI_SERVICE_SANDBOX === '1' ? '  (service portals: SANDBOX)' : '  (service portals: placeholders)'));
    // eslint-disable-next-line no-console
    console.log(`  Live transactions provider: ${liveProvider}` +
      (liveProvider === 'dev' ? '  (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)\n' : '\n'));
  });

  const shutdown = async () => {
    workerAbort.abort();
    clearInterval(passTimer);
    clearInterval(webhookTimer);
    clearInterval(dataTimer);
    clearInterval(gasTimer);
    clearInterval(fundingTimer);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start PayPali dev server:', err);
  process.exit(1);
});
