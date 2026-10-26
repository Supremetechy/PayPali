// src/ledger/budgetCalculator.ts
import { Money, PolicyRuleSet } from '../types/domain';

export interface BudgetContext {
  dailySpent: bigint;
  monthlySpent: bigint;
  activeReservations: bigint;
}

export class PolicyLimits {
  /**
   * Fail-closed check: determines maximum spendable capacity right now.
   * All amounts in minor units (bigint).
   */
  public static calculateAvailableLimit(
    policy: PolicyRuleSet,
    context: BudgetContext
  ): bigint {
    // 1. Validate policy limits are explicitly defined; undefined is zero
    const dailyCap = policy.maxDailyBudget?.amount ?? 0n;
    const monthlyCap = policy.maxMonthlyBudget?.amount ?? 0n;
    const perTxCap = policy.maxPerTransaction?.amount ?? 0n;

    if (dailyCap <= 0n || monthlyCap <= 0n || perTxCap <= 0n) {
      return 0n; // Fail-closed
    }

    // 2. Daily capacity remaining
    const committedAndPendingDaily = context.dailySpent + context.activeReservations;
    const remainingDaily = dailyCap > committedAndPendingDaily
      ? dailyCap - committedAndPendingDaily
      : 0n;

    // 3. Monthly capacity remaining
    const committedAndPendingMonthly = context.monthlySpent + context.activeReservations;
    const remainingMonthly = monthlyCap > committedAndPendingMonthly
      ? monthlyCap - committedAndPendingMonthly
      : 0n;

    // 4. Return minimum of per-transaction limit and remaining allowances
    return [perTxCap, remainingDaily, remainingMonthly].reduce((min, val) =>
      val < min ? val : min
    );
  }
}