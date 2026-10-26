import { createHash } from 'node:crypto';

export interface ApprovalPayload {
  intentId: string;
  recipientId: string;
  amountMinor: bigint;
  currency: string;
  policyVersion: number;
}

export class ApprovalBinder {
  public static computeFingerprint(payload: ApprovalPayload): string {
    const canonical = [
      payload.intentId,
      payload.recipientId,
      payload.amountMinor.toString(),
      payload.currency.toUpperCase(),
      payload.policyVersion.toString(),
    ].join(':');

    return createHash('sha256').update(canonical).digest('hex');
  }

  public static verifyFingerprint(
    fingerprint: string,
    payload: ApprovalPayload
  ): boolean {
    const expected = this.computeFingerprint(payload);
    return fingerprint === expected;
  }
}