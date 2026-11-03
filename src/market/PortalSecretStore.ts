import { PrismaClient } from '@prisma/client';
import { openSecret, sealSecret } from '../bazaar/keys';
import { findService } from './catalog';

const MAX_SECRET_BYTES = 16_384;

export class PortalSecretStore {
  constructor(private readonly prisma: PrismaClient) {}

  async set(serviceId: string, secret: string) {
    if (!findService(serviceId)) throw new Error('SERVICE_NOT_FOUND');
    if (!secret.trim() || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new Error('INVALID_PORTAL_SECRET');
    if (process.env.NODE_ENV === 'production' && !process.env.PAYPALI_KEY_ENCRYPTION_KEY) {
      throw new Error('PORTAL_SECRET_ENCRYPTION_KEY_REQUIRED');
    }

    const ciphertext = sealSecret(secret);
    return this.prisma.servicePortalSecret.upsert({
      where: { serviceId },
      create: { serviceId, ciphertext },
      update: { ciphertext },
      select: { serviceId: true, createdAt: true, updatedAt: true },
    });
  }

  async status(serviceId: string) {
    if (!findService(serviceId)) throw new Error('SERVICE_NOT_FOUND');
    const row = await this.prisma.servicePortalSecret.findUnique({
      where: { serviceId },
      select: { serviceId: true, createdAt: true, updatedAt: true },
    });
    return row ? { serviceId: row.serviceId, configured: true, createdAt: row.createdAt, updatedAt: row.updatedAt } : {
      serviceId, configured: false, createdAt: null, updatedAt: null,
    };
  }

  async resolve(serviceId: string): Promise<string | null> {
    const row = await this.prisma.servicePortalSecret.findUnique({ where: { serviceId }, select: { ciphertext: true } });
    if (!row) return null;
    if (process.env.NODE_ENV === 'production' && !process.env.PAYPALI_KEY_ENCRYPTION_KEY) {
      throw new Error('PORTAL_SECRET_ENCRYPTION_KEY_REQUIRED');
    }
    return openSecret(row.ciphertext);
  }

  async remove(serviceId: string): Promise<void> {
    if (!findService(serviceId)) throw new Error('SERVICE_NOT_FOUND');
    await this.prisma.servicePortalSecret.deleteMany({ where: { serviceId } });
  }
}
