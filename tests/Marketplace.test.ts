import { describe, expect, it } from 'vitest';
import { PLATFORMS, allowedServicesFrom, directory, validateSelections, DISCLAIMER } from '../src/market/directory';
import { SERVICES } from '../src/market/catalog';
import { PROVIDERS, providerFromClientName, setupFor } from '../src/connect/providers';
import { MANDATE_SERVICE_IDS } from '../src/connect/AgentConnectService';

describe('Marketplace directory', () => {
  it('every platform connects through a real provider; guided ones have vendor-specific surfaces', () => {
    for (const p of PLATFORMS) {
      expect(PROVIDERS.some((x) => x.id === p.providerId)).toBe(true);
      if (p.connect === 'guided') expect(p.providerId).not.toBe('custom');
      else expect(p.providerId).toBe('custom');
    }
    expect(PLATFORMS.map((p) => p.vendor)).toEqual(expect.arrayContaining(['Anthropic', 'OpenAI', 'Google', 'xAI', 'Meta', 'Anysphere', 'Cohere', 'Replit', 'Microsoft', 'IBM', 'Salesforce']));
  });

  it('Cursor is a guided provider with an mcp.json snippet', () => {
    expect(providerFromClientName('Cursor')).toBe('cursor');
    const s = setupFor('cursor', 'https://pp.example/mcp', 'tok_123');
    expect(s[0].setup).toContain('"url": "https://pp.example/mcp"');
    expect(s[0].setup).toContain('Bearer tok_123');
  });

  it('services include the new placeholder portals and are valid mandate services', () => {
    for (const id of ['netflix', 'hulu', 'amazon', 'walmart', 'tesla', 'uber', 'doordash']) {
      expect(SERVICES.find((s) => s.id === id)?.portal.status).toBe('placeholder');
      expect(MANDATE_SERVICE_IDS).toContain(id);
    }
    const d = directory(SERVICES as any);
    expect(d.services.every((s) => s.affiliation === 'none')).toBe(true);
    expect(d.platforms.every((p) => p.affiliation === 'none')).toBe(true);
    expect(DISCLAIMER).toMatch(/does not mean the company partners with or endorses PayPali/);
  });

  it('validates selections and derives a connection mandate from them', () => {
    const items = validateSelections([
      { kind: 'platform', id: 'claude' }, { kind: 'service', id: 'walmart' }, { kind: 'bazaar', id: 'sf-0152' },
      { kind: 'service', id: 'walmart' },   // duplicate dropped
    ]);
    expect(items).toHaveLength(3);
    expect(allowedServicesFrom(items)).toEqual(['agentbazaar', 'walmart']);
    expect(() => validateSelections([{ kind: 'platform', id: 'nope' }])).toThrow('UNKNOWN_PLATFORM:nope');
    expect(() => validateSelections([{ kind: 'service', id: 'stripe' }])).toThrow('UNKNOWN_SERVICE:stripe');
    expect(() => validateSelections([{ kind: 'bazaar', id: '../x' }])).toThrow('BAD_BAZAAR_ID');
    expect(() => validateSelections([{ kind: 'other', id: 'x' }])).toThrow('BAD_SELECTION_KIND');
    expect(() => validateSelections({})).toThrow('SELECTIONS_MUST_BE_ARRAY');
    expect(() => validateSelections(Array.from({ length: 61 }, (_, i) => ({ kind: 'bazaar', id: 'sf-' + i })))).toThrow('TOO_MANY_SELECTIONS');
  });
});
