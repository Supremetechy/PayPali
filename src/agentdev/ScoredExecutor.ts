import { LiveResult } from '../services/LivePaymentService';
import { ActionRequest, Quote, ScoreService, Settlement } from './ScoreService';

// ---------------------------------------------------------------------------
// Runs an action under the score gate: quote -> commit (points + bond) ->
// act -> judge -> settle. The judge must return an unambiguous boolean; when
// the outcome is genuinely unknown (AMBIGUOUS / REQUIRES_RECONCILIATION) the
// stake stays OPEN and is settled later by reconciliation — or expires as a
// loss. There is no path where an action runs without a committed stake.
// ---------------------------------------------------------------------------

export type Verdict = { success: boolean; reason?: string } | 'PENDING';

export interface ScoredRun<T> {
  allowed: boolean;
  quote: Quote;
  stakeId?: string;
  result?: T;
  settlement?: Settlement;
  pending?: boolean;
}

/** Judge for live PayPal results: PAID wins, a definitive refusal loses, unknown stays open. */
export function judgeLive(r: LiveResult): Verdict {
  if (r.status === 'PAID') return { success: true };
  if (r.status === 'DECLINED' || r.status === 'UNSUPPORTED') return { success: false, reason: r.reason ?? r.status };
  return 'PENDING';
}

export class ScoredExecutor {
  constructor(private readonly score: ScoreService) {}

  async run<T>(req: ActionRequest, act: () => Promise<T>, judge: (r: T) => Verdict): Promise<ScoredRun<T>> {
    const quote = await this.score.quote(req);
    if (!quote.allowed) return { allowed: false, quote };

    let committed: { stakeId: string; quote: Quote };
    try {
      committed = await this.score.commit(req);
    } catch (e) {
      const q = (e as { quote?: Quote }).quote;
      if (q) return { allowed: false, quote: q };
      throw e;
    }

    let result: T;
    try {
      result = await act();
    } catch (err) {
      // A thrown action is not proof of failure (it may have reached the provider).
      // Leave the stake OPEN for reconciliation; expiry settles it as a loss.
      return { allowed: true, quote: committed.quote, stakeId: committed.stakeId, pending: true };
    }
    const verdict = judge(result);
    if (verdict === 'PENDING') return { allowed: true, quote: committed.quote, stakeId: committed.stakeId, result, pending: true };

    const settlement = await this.score.settle(committed.stakeId, {
      success: verdict.success,
      evidence: { reason: verdict.reason ?? null, result: summarize(result) },
    });
    return { allowed: true, quote: committed.quote, stakeId: committed.stakeId, result, settlement };
  }
}

function summarize(r: unknown): unknown {
  return JSON.parse(JSON.stringify(r ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
