import { describe, expect, it } from 'vitest';
import { amountRisk, price, settleDelta, statusFor } from '../src/agentdev/scoring';

describe('score pricing (pure)', () => {
  it('prices a first MEDIUM attempt and shows both consequences before acting', () => {
    const p = price({ risk: 'MEDIUM', attemptNo: 1, confidencePct: 90, amountMinor: 0n });
    expect(p.stake).toBe(40);
    expect(p.fee).toBe(4);
    expect(p.onSuccess).toBe(Math.round(4 * 40 * 0.24) - 4); // 34
    expect(p.onFailure).toBe(Math.round(4 * 40 * -0.56) - 4); // -94
    expect(p.lockedPoints).toBeGreaterThanOrEqual(-p.onFailure); // worst case fully covered
  });

  it('doubles the stake on each retry of the same goal', () => {
    const a = [1, 2, 3].map((n) => price({ risk: 'LOW', attemptNo: n, confidencePct: 80, amountMinor: 0n }).stake);
    expect(a).toEqual([10, 20, 40]);
  });

  it('adds 1 point of stake per $10 moved', () => {
    expect(price({ risk: 'MEDIUM', attemptNo: 1, confidencePct: 80, amountMinor: 5_000n }).stake).toBe(45);
  });

  it('hedging at 50% always costs exactly the fee', () => {
    expect(settleDelta(100, 10, 50, true)).toBe(-10);
    expect(settleDelta(100, 10, 50, false)).toBe(-10);
  });

  it('never rewards a failed action, even one the agent predicted would fail', () => {
    for (const c of [1, 10, 30, 49]) expect(settleDelta(100, 10, c, false)).toBeLessThanOrEqual(-10);
  });

  it('is a proper scoring rule above 50%: honest confidence maximizes expected points', () => {
    const trueP = 0.8;
    const ev = (c: number) => trueP * settleDelta(100, 10, c, true) + (1 - trueP) * settleDelta(100, 10, c, false);
    const best = [55, 60, 70, 80, 90, 99].reduce((b, c) => (ev(c) > ev(b) ? c : b));
    expect(best).toBe(80);
  });

  it('rejects confidence outside 1..99', () => {
    expect(() => price({ risk: 'LOW', attemptNo: 1, confidencePct: 100, amountMinor: 0n })).toThrow('CONFIDENCE_MUST_BE_INT_1_TO_99');
    expect(() => price({ risk: 'LOW', attemptNo: 1, confidencePct: 0, amountMinor: 0n })).toThrow();
  });

  it('escalates risk by amount and derives status from balance vs floor', () => {
    expect(amountRisk(9_999n)).toBe('MEDIUM');
    expect(amountRisk(10_000n)).toBe('HIGH');
    expect(amountRisk(1_000_000n)).toBe('CRITICAL');
    expect(statusFor(300, 300)).toBe('SUSPENDED');
    expect(statusFor(449, 300)).toBe('PROBATION');
    expect(statusFor(450, 300)).toBe('ACTIVE');
  });
});
