import { createHash, randomBytes } from 'node:crypto';
import { AgentConnection, Prisma, PrismaClient, RiskClass } from '@prisma/client';
import { AgentDevService } from '../agentdev/AgentDevService';
import { SERVICES } from '../market/catalog';

/** Everything a mandate's allowedServices may name: Gas services plus the AgentBazaar marketplace. */
export const MANDATE_SERVICE_IDS = ['agentbazaar', 'skills', ...SERVICES.map((s) => s.id)];
/** Company data agents are named "data:<slug>", or "data:*" for all of them. */
export const DATA_SERVICE_ID = /^data:([a-z0-9][a-z0-9-]{1,39}|\*)$/;
export const isMandateServiceId = (s: string) => s === '*' || MANDATE_SERVICE_IDS.includes(s) || DATA_SERVICE_ID.test(s);
import { ALL_SCOPES, DEFAULT_SCOPES, Scope, findProvider, findSurface } from './providers';

// ---------------------------------------------------------------------------
// Agent Connect — binds an external agent (Claude, ChatGPT, Gemini, Grok, Muse,
// any MCP client) to one PayPali agent, with scopes and a mandate.
//
//   * TOKEN connections: the owner creates them and copies a bearer token once.
//   * OAUTH connections: created when the owner approves PayPali's consent
//     screen during an OAuth 2.1 sign-in (PKCE S256, single-use codes,
//     1h access tokens, rotating 30-day refresh tokens with reuse detection).
//   * Only SHA-256 hashes of tokens and codes are stored.
//   * The mandate can only narrow what the agent may do; the agent's own policy
//     and Score gate still apply to every payment.
// ---------------------------------------------------------------------------

export interface MandateInput {
  maxPerTxMinor: bigint;
  maxDailyMinor: bigint;
  approvalAboveMinor?: bigint | null;
  allowedServices?: string[];
  expiresAt?: Date | null;
  /** Explicit switch: subscriptions and recurring charges (monthly plans, data subscriptions). Off by default. */
  allowRecurring?: boolean;
}

export interface ConnectionInput {
  provider: string;
  label?: string;
  scopes?: string[];
  mandate: MandateInput;
}

export interface AuthContext {
  connection: AgentConnection;
  agentId: string;
  ownerId: string;
  scopes: Scope[];
}

const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 10 * 60_000;
const MAX_MINOR = 100_000_000n; // $1,000,000 hard ceiling on any mandate figure

export const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const mint = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const err = (code: string) => new Error(code);

export class AgentConnectService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dev: AgentDevService,
    private readonly now: () => Date = () => new Date()
  ) {}

  // -------------------------------------------------------------------------
  // Connections (owner side)
  // -------------------------------------------------------------------------
  async createConnection(ownerId: string, agentId: string, input: ConnectionInput, auth: 'TOKEN' | 'OAUTH' = 'TOKEN', oauthClientId?: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    if (!agent.isActive) throw err('AGENT_INACTIVE');
    if (!findProvider(input.provider)) throw err('UNKNOWN_PROVIDER');
    const scopes = normalizeScopes(input.scopes);
    const m = validateMandate(input.mandate);

    // Paying requires the agent to be developed (Score account) and to hold the
    // market.service capability. Approving gas:pay is the owner granting both.
    if (scopes.includes('gas:pay') || scopes.includes('bazaar:buy') || scopes.includes('data:query')) await this.dev.score.open(agentId);
    if (scopes.includes('data:query')) await this.dev.skills.grantCapability(ownerId, agentId, 'data.query', 'HIGH' as RiskClass);
    if (scopes.includes('gas:pay')) await this.dev.skills.grantCapability(ownerId, agentId, 'market.service', 'HIGH' as RiskClass);
    // Gas also pays other agents: approving gas:pay lets the agent license and call skills (skill.use).
    if (scopes.includes('gas:pay')) await this.dev.skills.grantCapability(ownerId, agentId, 'skill.use', 'HIGH' as RiskClass);
    if (scopes.includes('bazaar:buy')) await this.dev.skills.grantCapability(ownerId, agentId, 'bazaar.purchase', 'HIGH' as RiskClass);

    const connection = await this.prisma.agentConnection.create({
      data: {
        agentId, ownerId, provider: input.provider, label: (input.label || findProvider(input.provider)!.name).slice(0, 80),
        auth, oauthClientId: oauthClientId ?? null, scopes, ...m,
      },
    });
    if (auth === 'OAUTH') return { connection, token: null as string | null };
    const token = mint('ppk');
    await this.prisma.connectionToken.create({ data: { connectionId: connection.id, kind: 'ACCESS', tokenHash: hashToken(token) } });
    return { connection, token };
  }

  /**
   * Bring an agent the owner already uses (Claude, ChatGPT, Grok, DeepSeek…) while onboarding.
   * Token surfaces get a connection now, with a mandate taken from the owner's spending policy;
   * app surfaces (OAuth) connect when the owner adds PayPali in the app and approves on PayPali's
   * sign-in screen, so nothing is created here.
   */
  async connectExisting(ownerId: string, agentId: string, p: { surface: string; scopes?: string[]; allowRecurring?: boolean; label?: string }) {
    const found = findSurface(String(p.surface ?? ''));
    if (!found) throw err('UNKNOWN_SURFACE');
    if (found.surface.auth === 'oauth') return { mode: 'oauth' as const, provider: found.provider.id, surface: found.surface.id, connection: null, token: null };
    const policy = await this.prisma.policy.findFirst({ where: { ownerId, isActive: true }, orderBy: { version: 'desc' } });
    const perTx = policy?.maxPerTransactionMinor ?? 5_000n, daily = policy?.maxDailyBudgetMinor ?? 20_000n;
    const approval = policy && policy.requireHumanApprovalAbove > 0n ? policy.requireHumanApprovalAbove : null;
    const { connection, token } = await this.createConnection(ownerId, agentId, {
      provider: found.provider.id, label: (p.label || found.surface.name).slice(0, 80), scopes: p.scopes,
      mandate: { maxPerTxMinor: perTx, maxDailyMinor: daily < perTx ? perTx : daily, approvalAboveMinor: approval && approval <= perTx ? approval : null, allowRecurring: p.allowRecurring === true },
    });
    return { mode: 'token' as const, provider: found.provider.id, surface: found.surface.id, connection, token };
  }

  /**
   * Owner act: widen an existing connection so the assistant can use what the owner picked in the marketplace.
   * Adds scopes (granting the capabilities they need, as approving them at creation would) and adds services to
   * the mandate's allowedServices. Never narrows anything, never touches spending limits.
   */
  async extendAccess(ownerId: string, connectionId: string, p: { scopes?: string[]; services?: string[] }) {
    const c = await this.owned(ownerId, connectionId);
    if (c.status !== 'ACTIVE') throw err('CONNECTION_REVOKED');
    const scopes = normalizeScopes([...c.scopes, ...(p.scopes ?? [])]);
    const added = scopes.filter((x) => !c.scopes.includes(x));
    if (added.some((x) => x === 'gas:pay' || x === 'bazaar:buy' || x === 'data:query')) await this.dev.score.open(c.agentId);
    if (added.includes('data:query')) await this.dev.skills.grantCapability(ownerId, c.agentId, 'data.query', 'HIGH' as RiskClass);
    if (added.includes('gas:pay')) await this.dev.skills.grantCapability(ownerId, c.agentId, 'market.service', 'HIGH' as RiskClass);
    if (added.includes('gas:pay')) await this.dev.skills.grantCapability(ownerId, c.agentId, 'skill.use', 'HIGH' as RiskClass);
    if (added.includes('bazaar:buy')) await this.dev.skills.grantCapability(ownerId, c.agentId, 'bazaar.purchase', 'HIGH' as RiskClass);
    const allowed = c.allowedServices.includes('*') ? c.allowedServices : [...new Set([...c.allowedServices, ...(p.services ?? [])])];
    const m = validateMandate({ maxPerTxMinor: c.maxPerTxMinor, maxDailyMinor: c.maxDailyMinor, approvalAboveMinor: c.approvalAboveMinor, allowedServices: allowed, allowRecurring: c.allowRecurring, expiresAt: c.expiresAt });
    const updated = await this.prisma.agentConnection.update({ where: { id: c.id }, data: { scopes, allowedServices: m.allowedServices } });
    return { connection: updated, addedScopes: added, addedServices: m.allowedServices.filter((x) => !c.allowedServices.includes(x)) };
  }

  /** Issue a fresh bearer token for a TOKEN connection; every earlier token stops working. */
  async rotateToken(ownerId: string, connectionId: string) {
    const c = await this.owned(ownerId, connectionId);
    if (c.auth !== 'TOKEN') throw err('OAUTH_CONNECTION_USE_REFRESH');
    if (c.status !== 'ACTIVE') throw err('CONNECTION_REVOKED');
    const token = mint('ppk');
    await this.prisma.$transaction([
      this.prisma.connectionToken.updateMany({ where: { connectionId, revokedAt: null }, data: { revokedAt: this.now() } }),
      this.prisma.connectionToken.create({ data: { connectionId, kind: 'ACCESS', tokenHash: hashToken(token) } }),
    ]);
    return { token };
  }

  async revoke(ownerId: string, connectionId: string) {
    await this.owned(ownerId, connectionId);
    return this.revokeConnection(connectionId);
  }

  async updateMandate(ownerId: string, connectionId: string, patch: Partial<MandateInput>) {
    const c = await this.owned(ownerId, connectionId);
    const m = validateMandate({
      maxPerTxMinor: patch.maxPerTxMinor ?? c.maxPerTxMinor,
      maxDailyMinor: patch.maxDailyMinor ?? c.maxDailyMinor,
      approvalAboveMinor: patch.approvalAboveMinor !== undefined ? patch.approvalAboveMinor : c.approvalAboveMinor,
      allowedServices: patch.allowedServices ?? c.allowedServices,
      allowRecurring: patch.allowRecurring ?? c.allowRecurring,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : c.expiresAt,
    });
    return this.prisma.agentConnection.update({ where: { id: connectionId }, data: m });
  }

  list(where: { agentId?: string; ownerId?: string }) {
    return this.prisma.agentConnection.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  // -------------------------------------------------------------------------
  // Authentication for /mcp
  // -------------------------------------------------------------------------
  async authenticate(bearer: string | undefined): Promise<AuthContext> {
    if (!bearer || bearer.length > 200) throw err('INVALID_TOKEN');
    const t = await this.prisma.connectionToken.findUnique({ where: { tokenHash: hashToken(bearer) }, include: { connection: true } });
    if (!t || t.kind !== 'ACCESS' || t.revokedAt) throw err('INVALID_TOKEN');
    if (t.expiresAt && t.expiresAt <= this.now()) throw err('TOKEN_EXPIRED');
    const c = t.connection;
    if (c.status !== 'ACTIVE') throw err('CONNECTION_REVOKED');
    if (c.expiresAt && c.expiresAt <= this.now()) throw err('CONNECTION_EXPIRED');
    if (!c.lastUsedAt || this.now().getTime() - c.lastUsedAt.getTime() > 60_000) {
      await this.prisma.agentConnection.update({ where: { id: c.id }, data: { lastUsedAt: this.now() } });
    }
    return { connection: c, agentId: c.agentId, ownerId: c.ownerId, scopes: c.scopes as Scope[] };
  }

  // -------------------------------------------------------------------------
  // OAuth 2.1
  // -------------------------------------------------------------------------
  /** RFC 7591 dynamic client registration (public clients, PKCE only). */
  async registerClient(body: { client_name?: string; redirect_uris?: unknown; token_endpoint_auth_method?: string }) {
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(isAllowedRedirect)) throw err('invalid_redirect_uri');
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') throw err('invalid_client_metadata');
    const client = await this.prisma.oAuthClient.create({
      data: { id: 'ppc_' + randomBytes(16).toString('hex'), name: String(body.client_name || 'MCP client').slice(0, 100), redirectUris: uris as string[] },
    });
    return {
      client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    };
  }

  /** Validate an /oauth/authorize request. Errors are safe to show; nothing redirects to an unvalidated URI. */
  async checkAuthorizeRequest(q: Record<string, string | undefined>, resource: string) {
    const client = q.client_id ? await this.prisma.oAuthClient.findUnique({ where: { id: q.client_id } }) : null;
    if (!client) throw err('invalid_client');
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) throw err('invalid_redirect_uri');
    if (q.response_type !== 'code') throw err('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) throw err('invalid_request:pkce_s256_required');
    if (q.resource && q.resource !== resource) throw err('invalid_target');
    const requested = (q.scope || '').split(/\s+/).filter(Boolean);
    const scopes = requested.length ? requested.filter((s) => (ALL_SCOPES as string[]).includes(s)) : [...DEFAULT_SCOPES, 'gas:pay', 'bazaar:buy'];
    return { client, scopes };
  }

  /** Owner approved the consent screen: create the OAUTH connection and a single-use code. */
  async approve(ownerId: string, q: Record<string, string | undefined>, resource: string, decision: { agentId: string; provider: string; label?: string; scopes: string[]; mandate: MandateInput }) {
    const { client } = await this.checkAuthorizeRequest(q, resource);
    const { connection } = await this.createConnection(ownerId, decision.agentId, { provider: decision.provider, label: decision.label || client.name, scopes: decision.scopes, mandate: decision.mandate }, 'OAUTH', client.id);
    const code = mint('ppcode');
    await this.prisma.oAuthCode.create({
      data: { codeHash: hashToken(code), clientId: client.id, connectionId: connection.id, redirectUri: q.redirect_uri!, codeChallenge: q.code_challenge!, scopes: connection.scopes, expiresAt: new Date(this.now().getTime() + CODE_TTL_MS) },
    });
    const u = new URL(q.redirect_uri!);
    u.searchParams.set('code', code);
    if (q.state) u.searchParams.set('state', q.state);
    return { redirect: u.toString(), connection };
  }

  async exchangeCode(p: { code?: string; code_verifier?: string; redirect_uri?: string; client_id?: string }) {
    if (!p.code || !p.code_verifier || !p.client_id) throw err('invalid_request');
    const hash = hashToken(p.code);
    // Single use: claim the code atomically.
    const claimed = await this.prisma.oAuthCode.updateMany({ where: { codeHash: hash, usedAt: null }, data: { usedAt: this.now() } });
    const row = await this.prisma.oAuthCode.findUnique({ where: { codeHash: hash } });
    if (!row) throw err('invalid_grant');
    if (claimed.count !== 1) {
      await this.revokeConnection(row.connectionId); // code replay: assume interception, kill everything issued from it
      throw err('invalid_grant');
    }
    if (row.expiresAt <= this.now() || row.clientId !== p.client_id || (p.redirect_uri && p.redirect_uri !== row.redirectUri)) throw err('invalid_grant');
    const challenge = createHash('sha256').update(p.code_verifier).digest('base64url');
    if (challenge !== row.codeChallenge) throw err('invalid_grant');
    return this.issuePair(row.connectionId, row.scopes);
  }

  async refresh(p: { refresh_token?: string; client_id?: string }) {
    if (!p.refresh_token || !p.client_id) throw err('invalid_request');
    const t = await this.prisma.connectionToken.findUnique({ where: { tokenHash: hashToken(p.refresh_token) }, include: { connection: true } });
    if (!t || t.kind !== 'REFRESH' || t.connection.oauthClientId !== p.client_id) throw err('invalid_grant');
    if (t.revokedAt) {
      await this.revokeConnection(t.connectionId); // refresh-token reuse: the old token leaked
      throw err('invalid_grant');
    }
    if ((t.expiresAt && t.expiresAt <= this.now()) || t.connection.status !== 'ACTIVE') throw err('invalid_grant');
    await this.prisma.connectionToken.update({ where: { id: t.id }, data: { revokedAt: this.now() } });
    return this.issuePair(t.connectionId, t.connection.scopes);
  }

  /** RFC 7009: always succeeds from the caller's view. */
  async revokeToken(token: string | undefined) {
    if (!token) return;
    await this.prisma.connectionToken.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: this.now() } });
  }

  async ownerAgentsByEmail(email: string) {
    const owner = await this.prisma.owner.findUnique({ where: { email: email.trim().toLowerCase() }, include: { agents: { where: { isActive: true }, orderBy: { createdAt: 'desc' } } } });
    if (!owner) return null;
    return { ownerId: owner.id, agents: owner.agents.map((a) => ({ id: a.id, name: a.name })) };
  }

  // -------------------------------------------------------------------------
  private async issuePair(connectionId: string, scopes: string[]) {
    const access = mint('ppat');
    const refresh = mint('pprt');
    const now = this.now().getTime();
    await this.prisma.connectionToken.createMany({
      data: [
        { connectionId, kind: 'ACCESS', tokenHash: hashToken(access), expiresAt: new Date(now + ACCESS_TTL_MS) },
        { connectionId, kind: 'REFRESH', tokenHash: hashToken(refresh), expiresAt: new Date(now + REFRESH_TTL_MS) },
      ],
    });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(' ') };
  }

  private async revokeConnection(connectionId: string) {
    const now = this.now();
    const [c] = await this.prisma.$transaction([
      this.prisma.agentConnection.update({ where: { id: connectionId }, data: { status: 'REVOKED', revokedAt: now } }),
      this.prisma.connectionToken.updateMany({ where: { connectionId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
    return c;
  }

  private async owned(ownerId: string, connectionId: string) {
    const c = await this.prisma.agentConnection.findUnique({ where: { id: connectionId } });
    if (!c || c.ownerId !== ownerId) throw err('CONNECTION_NOT_FOUND');
    return c;
  }
}

function normalizeScopes(scopes?: string[]): Scope[] {
  const s = scopes && scopes.length ? scopes : DEFAULT_SCOPES;
  for (const x of s) if (!(ALL_SCOPES as string[]).includes(x)) throw err(`UNKNOWN_SCOPE:${x}`);
  const set = new Set(s as Scope[]);
  if (set.has('gas:pay')) set.add('gas:quote');
  return ALL_SCOPES.filter((x) => set.has(x));
}

function validateMandate(m: MandateInput) {
  const big = (v: unknown, code: string) => {
    if (typeof v !== 'bigint' || v < 1n || v > MAX_MINOR) throw err(code);
    return v;
  };
  if (!m) throw err('MANDATE_REQUIRED');
  const maxPerTxMinor = big(m.maxPerTxMinor, 'INVALID_MANDATE_PER_TX');
  const maxDailyMinor = big(m.maxDailyMinor, 'INVALID_MANDATE_DAILY');
  if (maxDailyMinor < maxPerTxMinor) throw err('MANDATE_DAILY_BELOW_PER_TX');
  const approvalAboveMinor = m.approvalAboveMinor == null ? null : big(m.approvalAboveMinor, 'INVALID_MANDATE_APPROVAL');
  const allowedServices = m.allowedServices && m.allowedServices.length ? m.allowedServices : ['*'];
  for (const s of allowedServices) if (!isMandateServiceId(s)) throw err(`UNKNOWN_SERVICE:${s}`);
  const expiresAt = m.expiresAt ?? null;
  if (expiresAt && !(expiresAt instanceof Date && !isNaN(expiresAt.getTime()))) throw err('INVALID_MANDATE_EXPIRY');
  if (m.allowRecurring !== undefined && typeof m.allowRecurring !== 'boolean') throw err('INVALID_MANDATE_ALLOW_RECURRING');
  return { maxPerTxMinor, maxDailyMinor, approvalAboveMinor, allowedServices, expiresAt, allowRecurring: m.allowRecurring === true } as const;
}

/** OAuth 2.1: https redirects, or http on loopback for native/dev clients. No fragments. */
function isAllowedRedirect(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch {
    return false;
  }
}

export type { Prisma };
