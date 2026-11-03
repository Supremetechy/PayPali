import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestDb, TestDb } from './harness';
import { PortalSecretStore } from '../src/market/PortalSecretStore';

let db: TestDb;
let prisma: PrismaClient;
let store: PortalSecretStore;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  store = new PortalSecretStore(prisma);
});

afterEach(async () => { await db.close(); });

describe('PortalSecretStore', () => {
  it('encrypts credentials at rest and exposes metadata without returning the value', async () => {
    const secret = 'provider-issued-integration-token';
    const saved = await store.set('netflix', secret);
    const row = await prisma.servicePortalSecret.findUniqueOrThrow({ where: { serviceId: 'netflix' } });

    expect(row.ciphertext).not.toContain(secret);
    expect(await store.resolve('netflix')).toBe(secret);
    expect(await store.status('netflix')).toMatchObject({
      serviceId: 'netflix',
      configured: true,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    expect(JSON.stringify(await store.status('netflix'))).not.toContain(secret);

    await store.remove('netflix');
    expect(await store.resolve('netflix')).toBeNull();
    expect(await store.status('netflix')).toMatchObject({ serviceId: 'netflix', configured: false });
  });

  it('rejects unknown services and invalid credentials', async () => {
    await expect(store.set('unknown-service', 'secret')).rejects.toThrow('SERVICE_NOT_FOUND');
    await expect(store.set('netflix', ' \n')).rejects.toThrow('INVALID_PORTAL_SECRET');
    await expect(store.set('netflix', 'x'.repeat(16_385))).rejects.toThrow('INVALID_PORTAL_SECRET');
  });
});
