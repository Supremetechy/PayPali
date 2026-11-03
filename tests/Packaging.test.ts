import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RateLimiter, clientIp } from '../src/connect/rateLimit';
import { resolveSecret, hydrateSecrets, redact } from '../src/server/secrets';
import { buildAgentCard } from '../src/connect/agentCard';
import { TOOLS } from '../src/connect/mcpServer';
import { ALL_SCOPES } from '../src/connect/providers';

describe('RateLimiter (per-caller sliding window)', () => {
  it('allows up to the limit, then blocks with a retry-after, then recovers as the window slides', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(3, 60_000, () => t);
    expect(rl.take('c1').ok).toBe(true);
    expect(rl.take('c1').ok).toBe(true);
    const third = rl.take('c1');
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    const blocked = rl.take('c1');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    // A different caller is unaffected.
    expect(rl.take('c2').ok).toBe(true);
    // Once the window passes, c1 is allowed again.
    t += 60_001;
    expect(rl.take('c1').ok).toBe(true);
  });

  it('limit <= 0 disables limiting', () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 100; i++) expect(rl.take('x').ok).toBe(true);
  });

  it('clientIp prefers the first x-forwarded-for hop, else the socket address', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.2' } })).toBe('203.0.113.9');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.2' } })).toBe('10.0.0.2');
  });
});

describe('Secrets (env or <NAME>_FILE)', () => {
  it('a plain variable wins; otherwise <NAME>_FILE is read and trimmed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paypali-secrets-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'from-file-value\n');
    expect(resolveSecret('X', { X: 'direct' })).toBe('direct');            // plain wins
    expect(resolveSecret('X', { X_FILE: file } as any)).toBe('from-file-value'); // trimmed
    expect(resolveSecret('X', {})).toBeUndefined();
  });

  it('hydrateSecrets copies a file value into its plain variable, and never overrides a set one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paypali-secrets-'));
    const file = join(dir, 'db');
    writeFileSync(file, 'postgres://x');
    const env: Record<string, string | undefined> = { PAYPALI_DATABASE_URL_FILE: file, PAYPAL_CLIENT_ID: 'keep' };
    const loaded = hydrateSecrets(['PAYPALI_DATABASE_URL', 'PAYPAL_CLIENT_ID'], env);
    expect(loaded).toEqual(['PAYPALI_DATABASE_URL']);
    expect(env.PAYPALI_DATABASE_URL).toBe('postgres://x');
    expect(env.PAYPAL_CLIENT_ID).toBe('keep');
  });

  it('an unreadable <NAME>_FILE throws a precise error', () => {
    expect(() => resolveSecret('X', { X_FILE: '/no/such/path/secret' } as any)).toThrow('SECRET_FILE_UNREADABLE:X_FILE');
  });

  it('redact never reveals a full secret', () => {
    expect(redact(undefined)).toBe('(unset)');
    expect(redact('short')).toBe('***');
    expect(redact('a-fairly-long-secret')).toContain('…');
    expect(redact('a-fairly-long-secret')).not.toContain('fairly');
  });
});

describe('A2A Agent Card', () => {
  const card = buildAgentCard({
    publicUrl: 'https://mcp.example.com',
    mcpUrl: 'https://mcp.example.com/mcp',
    legal: { entityName: 'Acme Payments, Inc.', termsUrl: 'https://mcp.example.com/legal/terms', privacyUrl: 'https://mcp.example.com/legal/privacy', contact: 'legal@example.com' },
  }) as any;

  it('is discoverable: names PayPali, points at the MCP endpoint, declares the MCP transport', () => {
    expect(card.name).toBe('PayPali');
    expect(card.url).toBe('https://mcp.example.com/mcp');
    expect(card.preferredTransport).toBe('MCP');
    expect(card.additionalInterfaces).toContainEqual({ transport: 'MCP', url: 'https://mcp.example.com/mcp' });
    expect(card.protocolVersion).toBeTruthy();
  });

  it('maps every MCP tool to an A2A skill tagged with its scope', () => {
    expect(card.skills).toHaveLength(TOOLS.length);
    const ctx = card.skills.find((s: any) => s.id === 'get_agent_context');
    expect(ctx).toBeTruthy();
    expect(ctx.tags).toContain('context:read');
  });

  it('advertises OAuth 2.1 and bearer auth, and the legal documents', () => {
    expect(card.securitySchemes.oauth2.flows.authorizationCode.authorizationUrl).toBe('https://mcp.example.com/oauth/authorize');
    expect(Object.keys(card.securitySchemes.oauth2.flows.authorizationCode.scopes).sort()).toEqual([...ALL_SCOPES].sort());
    expect(card.securitySchemes.bearer.scheme).toBe('bearer');
    expect(card.termsOfServiceUrl).toBe('https://mcp.example.com/legal/terms');
    expect(card['x-paypali'].legal.entity).toBe('Acme Payments, Inc.');
  });

  it('omits legal fields when no legal wrapper is configured', () => {
    const bare = buildAgentCard({ publicUrl: 'https://x', mcpUrl: 'https://x/mcp', legal: null }) as any;
    expect(bare.termsOfServiceUrl).toBeUndefined();
    expect(bare['x-paypali'].legal).toBeUndefined();
  });
});
