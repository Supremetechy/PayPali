import { PrismaClient } from '@prisma/client';
import { GasService } from './GasService';

// ---------------------------------------------------------------------------
// The Gas price floats.
//
// Gas is the unit agents price their acts in; what a Gas is worth in dollars moves with demand, epoch by epoch:
//
//   demand  = Gas actually transacted in the epoch (skill calls settled, Gas service orders, data answers)
//   next    = price × (1 + clamp((demand − target) / target, −1, 1) × maxChangeBps / 10 000)
//   bounds  = [floorMilli, ceilingMilli]
//
// So a busy network makes Gas dearer and a quiet one cheaper, at most maxChangeBps (12.5%) per epoch.
// Every quote, call, data query and prepaid license locks the price it was made at; spending limits
// (mandates, Power of Agency, grants) are in dollars, so a rising Gas price never lets an agent overspend.
// ---------------------------------------------------------------------------

export interface GasFloatConfig {
  enabled: boolean;
  epochMs: number;
  targetGasPerEpoch: number;
  maxChangeBps: number;
  floorMilli: number;
  ceilingMilli: number;
}

export const DEFAULT_GAS_FLOAT: GasFloatConfig = {
  enabled: true, epochMs: 3_600_000, targetGasPerEpoch: 20_000, maxChangeBps: 1250, floorMilli: 20, ceilingMilli: 1000,
};

export function gasFloatFromEnv(env: NodeJS.ProcessEnv = process.env): GasFloatConfig {
  const n = (k: string, d: number) => (env[k] && Number.isFinite(Number(env[k])) && Number(env[k]) > 0 ? Number(env[k]) : d);
  return {
    enabled: env.PAYPALI_GAS_FLOAT !== '0',
    epochMs: n('PAYPALI_GAS_EPOCH_MS', DEFAULT_GAS_FLOAT.epochMs),
    targetGasPerEpoch: n('PAYPALI_GAS_TARGET', DEFAULT_GAS_FLOAT.targetGasPerEpoch),
    maxChangeBps: Math.min(5000, n('PAYPALI_GAS_MAX_CHANGE_BPS', DEFAULT_GAS_FLOAT.maxChangeBps)),
    floorMilli: n('PAYPALI_GAS_FLOOR_MILLI', DEFAULT_GAS_FLOAT.floorMilli),
    ceilingMilli: n('PAYPALI_GAS_CEILING_MILLI', DEFAULT_GAS_FLOAT.ceilingMilli),
  };
}

export function nextPrice(price: number, demand: number, cfg: GasFloatConfig): number {
  const pressure = Math.max(-1, Math.min(1, (demand - cfg.targetGasPerEpoch) / cfg.targetGasPerEpoch));
  const next = Math.round(price * (1 + (pressure * cfg.maxChangeBps) / 10_000));
  return Math.max(cfg.floorMilli, Math.min(cfg.ceilingMilli, next));
}

export class GasPriceOracle {
  private epochStart: Date;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gas: GasService,
    readonly cfg: GasFloatConfig = DEFAULT_GAS_FLOAT,
    private readonly now: () => Date = () => new Date(),
  ) { this.epochStart = this.now(); }

  /** Resume from the last closed epoch (the price survives restarts with a persistent database). */
  async boot() {
    const last = await this.prisma.gasPriceEpoch.findFirst({ orderBy: { endedAt: 'desc' } });
    if (last) { this.gas.cfg.gasPriceMilli = last.nextPriceMilli; this.epochStart = last.endedAt; }
    return this.gas.priceMilli;
  }

  /** Close every epoch that has ended (call it on a timer). */
  async tick() {
    if (!this.cfg.enabled) return null;
    let closed = null;
    while (this.now().getTime() - this.epochStart.getTime() >= this.cfg.epochMs) closed = await this.closeEpoch(new Date(this.epochStart.getTime() + this.cfg.epochMs));
    return closed;
  }

  async closeEpoch(end: Date = this.now()) {
    const start = this.epochStart;
    const demand = await this.demand(start, end);
    const price = this.gas.priceMilli;
    const next = nextPrice(price, demand, this.cfg);
    const row = await this.prisma.gasPriceEpoch.create({ data: { startedAt: start, endedAt: end, priceMilli: price, demandGas: BigInt(demand), targetGas: BigInt(this.cfg.targetGasPerEpoch), nextPriceMilli: next } });
    this.gas.cfg.gasPriceMilli = next;
    this.epochStart = end;
    return row;
  }

  /** Gas transacted in [start, end): what the network was actually used for. */
  async demand(start: Date, end: Date): Promise<number> {
    const p = this.prisma, w = { gte: start, lt: end };
    const [calls, orders, queries] = await Promise.all([
      p.skillCall.aggregate({ _sum: { totalGas: true }, where: { status: 'SETTLED', settledAt: w } }),
      p.serviceOrder.aggregate({ _sum: { gasUnits: true, feeGas: true }, where: { status: { in: ['FULFILLED', 'PENDING_PROVIDER'] }, createdAt: w } }),
      p.dataQuery.aggregate({ _sum: { priceGas: true, feeGas: true }, where: { status: { in: ['ANSWERED', 'SETTLED'] }, createdAt: w } }),
    ]);
    return (calls._sum.totalGas ?? 0) + (orders._sum.gasUnits ?? 0) + (orders._sum.feeGas ?? 0) + (queries._sum.priceGas ?? 0) + (queries._sum.feeGas ?? 0);
  }

  async view() {
    const price = this.gas.priceMilli;
    const history = (await this.prisma.gasPriceEpoch.findMany({ orderBy: { endedAt: 'desc' }, take: 24 })).reverse();
    const prev = history.length ? history[history.length - 1].priceMilli : price;
    const soFar = this.cfg.enabled ? await this.demand(this.epochStart, this.now()) : 0;
    return {
      floating: this.cfg.enabled, priceMilli: price, usdPerGas: price / 100_000, usdPer1000Gas: price / 100,
      changeBps: prev ? Math.round(((price - prev) / prev) * 10_000) : 0,
      epoch: { startedAt: this.epochStart, endsAt: new Date(this.epochStart.getTime() + this.cfg.epochMs), demandSoFar: soFar, target: this.cfg.targetGasPerEpoch },
      rule: { maxChangeBps: this.cfg.maxChangeBps, floorMilli: this.cfg.floorMilli, ceilingMilli: this.cfg.ceilingMilli, epochMs: this.cfg.epochMs },
      history: history.map((h) => ({ endedAt: h.endedAt, priceMilli: h.priceMilli, demandGas: Number(h.demandGas), nextPriceMilli: h.nextPriceMilli })),
    };
  }
}
