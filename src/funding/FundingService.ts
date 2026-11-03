import { Allowance, BeneficiarySweep, FundingOrder, Prisma, PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import { LivePaymentService } from '../services/LivePaymentService';
import { IPayPalFundingGateway, SeedFundingRequest, SeedFundingResult } from '../providers/paypal/IPayPalFundingGateway';
import { openSecret, sealSecret } from '../bazaar/keys';
import { DevFundingProvider, FundingProvider } from './providers';

// ---------------------------------------------------------------------------
// Money in and out of PayPali through PayPal.
//
//   seed       onboarding: the owner approves a PayPal order, the agent is created with that
//              order as its seed's funding source, SeedFundingWorker captures it (crash-safe)
//   top-up     an owner funds an existing agent: approve → capture → credit
//   allowance  a recurring top-up: charged from the owner's saved PayPal (vaulted on an earlier
//              approval) or, without one, an order the owner approves each period
//   sweep      an agent's earnings above a working balance are paid to its beneficiary's
//              PayPal through the Payouts API
//
// Every credit is idempotent on the PayPal capture id, so a capture seen twice (return page
// and JS SDK callback, or a retry) credits once. Amounts are checked against what we asked for.
// ---------------------------------------------------------------------------

const err = (c: string) => new Error(c);
const DAY = 86_400_000;
export const MAX_FUNDING_MINOR = 1_000_000n;        // $10,000 per order
export const MAX_ALLOWANCE_MINOR = 500_000n;        // $5,000 per period
const DEV_SEED_REF = /^(vault_dev_|dev_)/;

export type Period = 'WEEKLY' | 'MONTHLY';

export interface FundingOptions {
  publicUrl: string;
  /** Accept dev seed references (vault_dev_*) even with PayPal configured: local demo stacks only. */
  allowDevSeeds: boolean;
  now: () => Date;
}

export class FundingService {
  private readonly o: FundingOptions;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: AgentWalletService,
    readonly provider: FundingProvider,
    private readonly live: LivePaymentService | null,
    opts: Partial<FundingOptions> = {},
  ) {
    this.o = { publicUrl: 'http://localhost:4000', allowDevSeeds: false, now: () => new Date(), ...opts };
  }

  get isLive() { return this.provider.id !== 'dev'; }

  config() {
    return {
      provider: this.provider.id, live: this.isLive, clientId: this.provider.clientId, currencies: ['USD'],
      sdkUrl: this.provider.clientId ? `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(this.provider.clientId)}&currency=USD&intent=capture&components=buttons` : null,
      maxOrderMinor: MAX_FUNDING_MINOR, maxAllowanceMinor: MAX_ALLOWANCE_MINOR,
      // false: this PayPal app can't save PayPal accounts, so allowances are approved each period.
      vault: this.provider.id === 'dev' ? true : (this.provider.vaultAvailable ?? null),
    };
  }

  // =========================================================================
  // Orders: seed, top-up
  // =========================================================================

  /** Onboarding seed: no owner yet. The order id becomes the seed's fundingSourceReference. */
  async createSeedOrder(p: { amountMinor: bigint; currency: string; saveForAllowance?: boolean; returnPath?: string }) {
    return this.createOrder({ purpose: 'SEED', ownerId: null, agentId: null, ...p, description: 'PayPali: seed for a new agent' });
  }

  /** Owner act: fund an existing agent. */
  async createTopUp(ownerId: string, agentId: string, p: { amountMinor: bigint; currency: string; saveForAllowance?: boolean; returnPath?: string }) {
    const agent = await this.ownedAgent(ownerId, agentId);
    if (!agent.isActive) throw err('AGENT_INACTIVE');
    return this.createOrder({ purpose: 'TOPUP', ownerId, agentId, ...p, description: `PayPali: fund ${agent.name}`.slice(0, 120) });
  }

  private async createOrder(p: { purpose: 'SEED' | 'TOPUP' | 'ALLOWANCE'; ownerId: string | null; agentId: string | null; amountMinor: bigint; currency: string; saveForAllowance?: boolean; returnPath?: string; description: string; allowanceRunId?: string }) {
    if (p.currency !== 'USD') throw err('CURRENCY_NOT_SUPPORTED');
    if (!(typeof p.amountMinor === 'bigint' && p.amountMinor >= 100n && p.amountMinor <= MAX_FUNDING_MINOR)) throw err('INVALID_FUNDING_AMOUNT');
    const id = crypto.randomUUID();
    const back = safePath(p.returnPath) ?? (p.purpose === 'SEED' ? '/' : '/dashboard');
    const ret = new URL('/fund/return', this.o.publicUrl);
    ret.searchParams.set('f', id); ret.searchParams.set('next', back);
    const cancel = new URL(ret); cancel.searchParams.set('cancel', '1');
    const { orderId, approveUrl, vaultSkipped } = await this.provider.createOrder({
      amountMinor: p.amountMinor, currency: p.currency, reference: id, description: p.description, saveForAllowance: !!p.saveForAllowance,
      returnUrl: ret.toString(), cancelUrl: cancel.toString(), requestId: `fundorder:${id}`,
    });
    const row = await this.prisma.fundingOrder.create({
      data: {
        id, ownerId: p.ownerId, agentId: p.agentId, purpose: p.purpose, provider: this.provider.id, providerOrderId: orderId,
        amountMinor: p.amountMinor, currency: p.currency, saveForAllowance: !!p.saveForAllowance && !vaultSkipped, approveUrl, allowanceRunId: p.allowanceRunId ?? null,
      },
    });
    return { fundingId: row.id, orderId, approveUrl, provider: this.provider.id, amountMinor: row.amountMinor, currency: row.currency, ...(vaultSkipped ? { vaultSkipped } : {}) };
  }

  /**
   * Capture an approved top-up or allowance order and credit the agent. Safe to call twice (return page and
   * JS SDK callback): PayPal-Request-Id dedupes the capture, the capture id dedupes the credit.
   * Seeds are captured by SeedFundingWorker, never here.
   */
  async capture(orderId: string, actor?: { ownerId: string }) {
    const f = await this.prisma.fundingOrder.findUnique({ where: { providerOrderId: orderId } });
    if (!f) throw err('FUNDING_ORDER_NOT_FOUND');
    if (actor && f.ownerId && f.ownerId !== actor.ownerId) throw err('FUNDING_ORDER_NOT_FOUND');
    if (f.purpose === 'SEED') return this.view(f);
    if (f.status === 'CAPTURED' || f.status === 'DECLINED' || f.status === 'CANCELLED') return this.view(f);
    const out = await this.provider.captureOrder(orderId, `fundcap:${f.id}`);
    if (out.status === 'NOT_APPROVED') return { ...this.view(f), pending: true };
    if (out.status !== 'COMPLETED') {
      const updated = await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: out.status === 'DECLINED' ? 'DECLINED' : 'FAILED', error: out.reason } });
      if (f.allowanceRunId) await this.prisma.allowanceRun.update({ where: { id: f.allowanceRunId }, data: { status: out.status === 'DECLINED' ? 'DECLINED' : 'FAILED', reason: out.reason } });
      return this.view(updated);
    }
    return this.view(await this.credit(f, out.captureId, out.amountMinor, out.currency, out.vault ?? null));
  }

  /** The owner cancelled at PayPal. */
  async cancel(fundingId: string) {
    const f = await this.prisma.fundingOrder.findUnique({ where: { id: fundingId } });
    if (!f) throw err('FUNDING_ORDER_NOT_FOUND');
    if (f.status !== 'CREATED') return this.view(f);
    return this.view(await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'CANCELLED' } }));
  }

  private async credit(f: FundingOrder, captureId: string, amountMinor: bigint, currency: string, vault: { id: string; customerId?: string } | null) {
    if (amountMinor !== f.amountMinor || currency !== f.currency) {
      return this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'FAILED', captureId, error: 'CAPTURE_AMOUNT_MISMATCH' } });
    }
    const ledgerKey = `paypal:${captureId}`;
    await this.wallet.receive({ agentId: f.agentId!, amountMinor, currency, idempotencyKey: ledgerKey, type: 'EXTERNAL_TOPUP' });
    const updated = await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'CAPTURED', captureId, ledgerKey, error: null } });
    if (vault && f.ownerId) await this.saveVault(f.ownerId, vault);
    if (f.allowanceRunId) await this.prisma.allowanceRun.update({ where: { id: f.allowanceRunId }, data: { status: 'CAPTURED' } });
    return updated;
  }

  private async saveVault(ownerId: string, vault: { id: string; customerId?: string }) {
    const existing = await this.prisma.ownerPaymentMethod.findMany({ where: { ownerId, status: 'ACTIVE' } });
    if (existing.some((m) => safeOpen(m.vaultIdSealed) === vault.id)) return;
    await this.prisma.ownerPaymentMethod.create({
      data: { ownerId, provider: this.provider.id, vaultIdSealed: sealSecret(vault.id), customerId: vault.customerId ?? null, label: `PayPal (saved ${this.o.now().toISOString().slice(0, 10)})` },
    });
  }

  async orders(ownerId: string, agentId?: string) {
    const rows = await this.prisma.fundingOrder.findMany({ where: { ownerId, ...(agentId ? { agentId } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => this.view(r));
  }

  async getByOrderId(orderId: string) {
    const f = await this.prisma.fundingOrder.findUnique({ where: { providerOrderId: orderId } });
    return f ? this.view(f) : null;
  }

  async getFunding(fundingId: string) {
    const f = await this.prisma.fundingOrder.findUnique({ where: { id: fundingId } });
    return f ? this.view(f) : null;
  }

  private view(f: FundingOrder) {
    return {
      fundingId: f.id, orderId: f.providerOrderId, purpose: f.purpose, provider: f.provider, agentId: f.agentId, amountMinor: f.amountMinor, currency: f.currency,
      status: f.status, captureId: f.captureId, error: f.error, saveForAllowance: f.saveForAllowance, approveUrl: f.status === 'CREATED' ? f.approveUrl : null, createdAt: f.createdAt,
    };
  }

  // =========================================================================
  // Seeds (SeedFundingWorker's gateway)
  // =========================================================================

  /** Live mode: the seed must name a PayPal order PayPali created for exactly this amount, not yet used. */
  async checkSeedReference(ref: string, amountMinor: bigint, currency: string): Promise<string | null> {
    const f = await this.prisma.fundingOrder.findUnique({ where: { providerOrderId: ref } });
    if (!f) {
      // Without PayPal configured any reference is a simulated funding source (the original dev behaviour).
      if (!this.isLive) return null;
      return DEV_SEED_REF.test(ref) && this.o.allowDevSeeds ? null : 'SEED_NEEDS_PAYPAL_APPROVAL';
    }
    if (f.purpose !== 'SEED') return 'UNKNOWN_FUNDING_ORDER';
    if (f.status !== 'CREATED') return 'FUNDING_ORDER_ALREADY_USED';
    if (f.amountMinor !== amountMinor || f.currency !== currency) return 'SEED_AMOUNT_DIFFERS_FROM_APPROVAL';
    if (await this.prisma.seed.findFirst({ where: { fundingSourceReference: ref } })) return 'FUNDING_ORDER_ALREADY_USED';
    return null;
  }

  /** The gateway SeedFundingWorker captures through. Dev references go to `dev` (when allowed). */
  seedGateway(dev: IPayPalFundingGateway): IPayPalFundingGateway {
    return {
      captureFromBalance: async (req: SeedFundingRequest): Promise<SeedFundingResult> => {
        const f = await this.prisma.fundingOrder.findUnique({ where: { providerOrderId: req.fundingSourceReference } });
        if (!f) {
          if (!this.isLive || (this.o.allowDevSeeds && DEV_SEED_REF.test(req.fundingSourceReference))) return dev.captureFromBalance(req);
          return { status: 'INSUFFICIENT_FUNDS' };                                         // terminal: not an order we created
        }
        if (f.purpose !== 'SEED') return { status: 'INSUFFICIENT_FUNDS' };
        if (f.status === 'CAPTURED' && f.captureId) return { status: 'CAPTURED', captureId: f.captureId };
        const out = await this.provider.captureOrder(req.fundingSourceReference, req.idempotencyKey);
        if (out.status === 'COMPLETED') {
          if (out.amountMinor !== req.amountMinor || out.currency !== req.currency) {
            await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'FAILED', captureId: out.captureId, error: 'CAPTURE_AMOUNT_MISMATCH' } });
            return { status: 'FAILED', reason: 'CAPTURE_AMOUNT_MISMATCH' };
          }
          const seed = await this.prisma.seed.findFirst({ where: { fundingSourceReference: req.fundingSourceReference } });
          await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'CAPTURED', captureId: out.captureId, ownerId: req.ownerId, agentId: seed?.agentId ?? f.agentId, ledgerKey: 'seed' } });
          if (out.vault) await this.saveVault(req.ownerId, out.vault);
          return { status: 'CAPTURED', captureId: out.captureId };
        }
        if (out.status === 'DECLINED') {
          await this.prisma.fundingOrder.update({ where: { id: f.id }, data: { status: 'DECLINED', error: out.reason } });
          return { status: 'INSUFFICIENT_FUNDS' };
        }
        return { status: 'FAILED', reason: out.reason };   // NOT_APPROVED / ERROR: the worker retries
      },
    };
  }

  // =========================================================================
  // Saved PayPal accounts
  // =========================================================================

  async paymentMethods(ownerId: string) {
    const rows = await this.prisma.ownerPaymentMethod.findMany({ where: { ownerId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    return rows.map((m) => ({ id: m.id, label: m.label, provider: m.provider, createdAt: m.createdAt }));
  }

  async removePaymentMethod(ownerId: string, id: string) {
    const m = await this.prisma.ownerPaymentMethod.findUnique({ where: { id } });
    if (!m || m.ownerId !== ownerId) throw err('PAYMENT_METHOD_NOT_FOUND');
    await this.prisma.ownerPaymentMethod.update({ where: { id }, data: { status: 'REMOVED' } });
    await this.prisma.allowance.updateMany({ where: { paymentMethodId: id }, data: { paymentMethodId: null } });
    return { removed: true };
  }

  // =========================================================================
  // Allowances
  // =========================================================================

  async setAllowance(ownerId: string, agentId: string, p: { amountMinor: bigint; currency?: string; period: Period; paymentMethodId?: string | null; startNow?: boolean }) {
    await this.ownedAgent(ownerId, agentId);
    const currency = p.currency ?? 'USD';
    if (currency !== 'USD') throw err('CURRENCY_NOT_SUPPORTED');
    if (!(typeof p.amountMinor === 'bigint' && p.amountMinor >= 100n && p.amountMinor <= MAX_ALLOWANCE_MINOR)) throw err('INVALID_ALLOWANCE_AMOUNT');
    if (p.period !== 'WEEKLY' && p.period !== 'MONTHLY') throw err('INVALID_ALLOWANCE_PERIOD');
    let paymentMethodId: string | null = null;
    if (p.paymentMethodId) {
      const m = await this.prisma.ownerPaymentMethod.findUnique({ where: { id: p.paymentMethodId } });
      if (!m || m.ownerId !== ownerId || m.status !== 'ACTIVE') throw err('PAYMENT_METHOD_NOT_FOUND');
      paymentMethodId = m.id;
    } else if (p.paymentMethodId === undefined) {
      paymentMethodId = (await this.prisma.ownerPaymentMethod.findFirst({ where: { ownerId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } }))?.id ?? null;
    }
    const now = this.o.now();
    const nextRunAt = p.startNow === false ? addPeriod(now, p.period) : now;
    const data = { amountMinor: p.amountMinor, currency, period: p.period, paymentMethodId, status: 'ACTIVE' as const, nextRunAt, lastError: null };
    const a = await this.prisma.allowance.upsert({ where: { agentId }, update: data, create: { agentId, ownerId, ...data } });
    return this.allowanceView(a);
  }

  async setAllowanceStatus(ownerId: string, agentId: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELLED') {
    const a = await this.prisma.allowance.findUnique({ where: { agentId } });
    if (!a || a.ownerId !== ownerId) throw err('ALLOWANCE_NOT_FOUND');
    const data: Prisma.AllowanceUpdateInput = { status };
    if (status === 'ACTIVE' && a.nextRunAt < this.o.now()) data.nextRunAt = this.o.now();
    return this.allowanceView(await this.prisma.allowance.update({ where: { id: a.id }, data }));
  }

  async getAllowance(agentId: string) {
    const a = await this.prisma.allowance.findUnique({ where: { agentId } });
    if (!a) return null;
    const runs = await this.prisma.allowanceRun.findMany({ where: { allowanceId: a.id }, orderBy: { createdAt: 'desc' }, take: 12 });
    const pending = await this.prisma.fundingOrder.findMany({ where: { allowanceRunId: { in: runs.map((r) => r.id) }, status: 'CREATED' } });
    return { ...this.allowanceView(a), runs: runs.map((r) => ({ periodKey: r.periodKey, mode: r.mode, status: r.status, amountMinor: r.amountMinor, reason: r.reason, createdAt: r.createdAt, approveUrl: pending.find((f) => f.allowanceRunId === r.id)?.approveUrl ?? null })) };
  }

  /** Charge every allowance that is due. One charge per allowance per period, whatever happens. */
  async runDueAllowances(): Promise<number> {
    const due = await this.prisma.allowance.findMany({ where: { status: 'ACTIVE', nextRunAt: { lte: this.o.now() } }, take: 100 });
    let n = 0;
    for (const a of due) { if (await this.runAllowance(a)) n++; }
    return n;
  }

  private async runAllowance(a: Allowance): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: a.agentId } });
    if (!agent || !agent.isActive) {
      await this.prisma.allowance.update({ where: { id: a.id }, data: { status: 'PAUSED', lastError: 'AGENT_INACTIVE' } });
      return false;
    }
    const periodKey = periodKeyFor(a.nextRunAt, a.period as Period);
    let runId: string;
    try {
      runId = (await this.prisma.allowanceRun.create({ data: { allowanceId: a.id, periodKey, mode: a.paymentMethodId ? 'SAVED' : 'APPROVAL', status: 'PROCESSING', amountMinor: a.amountMinor } })).id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.allowance.update({ where: { id: a.id }, data: { nextRunAt: addPeriod(a.nextRunAt, a.period as Period) } });
        return false;   // this period was already handled
      }
      throw e;
    }
    const advance = { nextRunAt: addPeriod(a.nextRunAt, a.period as Period), lastRunAt: this.o.now() };

    const method = a.paymentMethodId ? await this.prisma.ownerPaymentMethod.findUnique({ where: { id: a.paymentMethodId } }) : null;
    if (method && method.status === 'ACTIVE') {
      const out = await this.provider.chargeSaved({
        vaultId: openSecret(method.vaultIdSealed), amountMinor: a.amountMinor, currency: a.currency, reference: runId,
        description: `PayPali allowance ${periodKey}`, requestId: `allowance:${runId}`,
      });
      if (out.status === 'COMPLETED') {
        const f = await this.prisma.fundingOrder.create({
          data: { ownerId: a.ownerId, agentId: a.agentId, purpose: 'ALLOWANCE', provider: this.provider.id, providerOrderId: out.orderId ?? `allowance:${runId}`, amountMinor: a.amountMinor, currency: a.currency, allowanceRunId: runId },
        });
        await this.credit(f, out.captureId, out.amountMinor, out.currency, null);
        await this.prisma.allowanceRun.update({ where: { id: runId }, data: { status: 'CAPTURED', fundingOrderId: f.id } });
        await this.prisma.allowance.update({ where: { id: a.id }, data: { ...advance, lastError: null } });
        return true;
      }
      if (out.status === 'DECLINED') {
        // A declined saved account stops the allowance until the owner looks at it.
        await this.prisma.allowanceRun.update({ where: { id: runId }, data: { status: 'DECLINED', reason: out.reason } });
        await this.prisma.allowance.update({ where: { id: a.id }, data: { ...advance, status: 'PAUSED', lastError: `PAYPAL_DECLINED:${out.reason}` } });
        return false;
      }
      // Unknown / transient: forget this attempt and try again in 15 minutes (same period).
      await this.prisma.allowanceRun.delete({ where: { id: runId } });
      await this.prisma.allowance.update({ where: { id: a.id }, data: { nextRunAt: new Date(this.o.now().getTime() + 15 * 60_000), lastError: out.reason } });
      return false;
    }

    // No saved PayPal: create this period's order for the owner to approve.
    const order = await this.createOrder({
      purpose: 'ALLOWANCE', ownerId: a.ownerId, agentId: a.agentId, amountMinor: a.amountMinor, currency: a.currency, saveForAllowance: true,
      description: `PayPali allowance ${periodKey}`, allowanceRunId: runId,
    });
    await this.prisma.allowanceRun.update({ where: { id: runId }, data: { status: 'AWAITING_APPROVAL', fundingOrderId: order.fundingId } });
    await this.prisma.allowance.update({ where: { id: a.id }, data: { ...advance, lastError: null } });
    return true;
  }

  private allowanceView(a: Allowance) {
    return { agentId: a.agentId, amountMinor: a.amountMinor, currency: a.currency, period: a.period, mode: a.paymentMethodId ? 'SAVED_PAYPAL' : 'APPROVE_EACH_PERIOD', paymentMethodId: a.paymentMethodId, status: a.status, nextRunAt: a.nextRunAt, lastRunAt: a.lastRunAt, lastError: a.lastError };
  }

  // =========================================================================
  // Beneficiary sweeps (money out: Payouts)
  // =========================================================================

  async setSweep(ownerId: string, agentId: string, p: { receiver: string; keepMinor: bigint; minPayoutMinor?: bigint; period: Period | 'MANUAL'; currency?: string }) {
    await this.ownedAgent(ownerId, agentId);
    if (typeof p.receiver !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.receiver) || p.receiver.length > 254) throw err('BENEFICIARY_EMAIL_REQUIRED');
    if (!(typeof p.keepMinor === 'bigint' && p.keepMinor >= 0n)) throw err('INVALID_KEEP_AMOUNT');
    const minPayoutMinor = p.minPayoutMinor ?? 100n;
    if (!(minPayoutMinor >= 1n)) throw err('INVALID_MIN_PAYOUT');
    if (!['WEEKLY', 'MONTHLY', 'MANUAL'].includes(p.period)) throw err('INVALID_SWEEP_PERIOD');
    const now = this.o.now();
    const data = { receiver: p.receiver.toLowerCase(), keepMinor: p.keepMinor, minPayoutMinor, currency: p.currency ?? 'USD', period: p.period, status: 'ACTIVE', nextRunAt: p.period === 'MANUAL' ? new Date(Date.UTC(9999, 0, 1)) : addPeriod(now, p.period) };
    const s = await this.prisma.beneficiarySweep.upsert({ where: { agentId }, update: data, create: { agentId, ownerId, ...data } });
    return this.sweepView(s);
  }

  async getSweep(agentId: string) {
    const s = await this.prisma.beneficiarySweep.findUnique({ where: { agentId } });
    return s ? this.sweepView(s) : null;
  }

  /** Owner act: pay the beneficiary now. */
  async sweepNow(ownerId: string, agentId: string) {
    const s = await this.prisma.beneficiarySweep.findUnique({ where: { agentId } });
    if (!s || s.ownerId !== ownerId) throw err('SWEEP_NOT_FOUND');
    return this.runSweep(s, `manual:${this.o.now().getTime()}`);
  }

  async runDueSweeps(): Promise<number> {
    const due = await this.prisma.beneficiarySweep.findMany({ where: { status: 'ACTIVE', nextRunAt: { lte: this.o.now() } }, take: 100 });
    for (const s of due) await this.runSweep(s, periodKeyFor(s.nextRunAt, s.period as Period));
    return due.length;
  }

  private async runSweep(s: BeneficiarySweep, key: string) {
    if (!this.live) throw err('PAYOUTS_NOT_CONFIGURED');
    const balance = await this.wallet.getBalance(s.agentId, s.currency);
    const amount = balance - s.keepMinor;
    let result: Record<string, unknown>;
    if (amount < s.minPayoutMinor) result = { status: 'NOTHING_TO_PAY', balanceMinor: balance.toString(), keepMinor: s.keepMinor.toString() };
    else {
      const r = await this.live.payoutExternal({ agentId: s.agentId, receiver: s.receiver, amountMinor: amount, currency: s.currency, note: 'Earnings from your PayPali agent', idempotencyKey: `sweep:${s.id}:${key}` });
      result = { ...r, amountMinor: amount.toString(), receiver: s.receiver };
    }
    const next = s.period === 'MANUAL' ? s.nextRunAt : addPeriod(s.nextRunAt < this.o.now() ? this.o.now() : s.nextRunAt, s.period as Period);
    await this.prisma.beneficiarySweep.update({ where: { id: s.id }, data: { lastRunAt: this.o.now(), lastResult: JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))), nextRunAt: next } });
    return result;
  }

  private sweepView(s: BeneficiarySweep) {
    return { agentId: s.agentId, receiver: s.receiver, keepMinor: s.keepMinor, minPayoutMinor: s.minPayoutMinor, currency: s.currency, period: s.period, status: s.status, nextRunAt: s.period === 'MANUAL' ? null : s.nextRunAt, lastRunAt: s.lastRunAt, lastResult: s.lastResult };
  }

  /** Kill switch support: stop money moving in either direction for one agent. */
  async pauseAll(agentId: string) {
    const [a, s] = await Promise.all([
      this.prisma.allowance.updateMany({ where: { agentId, status: 'ACTIVE' }, data: { status: 'PAUSED', lastError: 'AGENT_STOPPED' } }),
      this.prisma.beneficiarySweep.updateMany({ where: { agentId, status: 'ACTIVE' }, data: { status: 'PAUSED' } }),
    ]);
    return { allowancesPaused: a.count, sweepsPaused: s.count };
  }

  private async ownedAgent(ownerId: string, agentId: string) {
    const a = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a || a.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    return a;
  }

  /** For the dev approval page. */
  get dev(): DevFundingProvider | null { return this.provider instanceof DevFundingProvider ? this.provider : null; }
}

function safeOpen(s: string) { try { return openSecret(s); } catch { return null; } }

export function safePath(p: unknown): string | null {
  return typeof p === 'string' && /^\/[A-Za-z0-9/_\-.?=&%#]*$/.test(p) && !p.startsWith('//') ? p : null;
}

export function addPeriod(d: Date, period: Period): Date {
  if (period === 'WEEKLY') return new Date(d.getTime() + 7 * DAY);
  const n = new Date(d);
  const day = n.getUTCDate();
  n.setUTCDate(1); n.setUTCMonth(n.getUTCMonth() + 1);
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
  n.setUTCDate(Math.min(day, last));
  return n;
}

export function periodKeyFor(d: Date, period: Period): string {
  if (period === 'MONTHLY') return d.toISOString().slice(0, 7);
  // ISO week
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
