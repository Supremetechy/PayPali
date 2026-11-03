import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Owner sign-in for the PayPali web pages (Onboarding, Dashboard, Marketplace).
//
//   session   HttpOnly, SameSite=Lax cookie `pp_session` (30 days). Only
//             sha256(token) is stored, so a database leak yields no sessions.
//   sign-in   single-use email link (15 minutes) → /auth/verify?token=… sets
//             the cookie and redirects to a same-site `next` path.
//   new owner onboarding signs a brand-new owner in directly; an EXISTING
//             email must use a sign-in link (otherwise anyone could take over
//             an account by onboarding with its email).
//
// Email delivery: `deliver(email, link)` is pluggable. Without one, dev builds
// return the link in the API response (and log it); production refuses with
// LOGIN_EMAIL_NOT_CONFIGURED rather than silently dropping it.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'pp_session';
const DAY = 86_400_000;
const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SessionOptions {
  publicUrl: string;
  sessionTtlMs?: number;
  linkTtlMs?: number;
  /** Sends the sign-in link. Absent: dev returns it in the response; production refuses. */
  deliver?: (email: string, link: string) => Promise<void>;
  production?: boolean;
  now?: () => Date;
}

/** Only same-site absolute paths: "/dashboard?agent=x" yes; "//evil.com", "https://…", "/\\evil" no. */
export function safeNext(next: unknown, fallback = '/dashboard'): string {
  const n = typeof next === 'string' ? next.trim() : '';
  if (!n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\') || /[\r\n]/.test(n) || n.length > 2000) return fallback;   // OAuth authorize URLs (PKCE, state, redirect) are long
  return n;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export class SessionService {
  private readonly ttl: number;
  private readonly linkTtl: number;
  private readonly now: () => Date;
  private readonly secure: boolean;
  readonly production: boolean;

  constructor(private readonly prisma: PrismaClient, private readonly opts: SessionOptions) {
    this.ttl = opts.sessionTtlMs ?? 30 * DAY;
    this.linkTtl = opts.linkTtlMs ?? 15 * 60_000;
    this.now = opts.now ?? (() => new Date());
    this.secure = opts.publicUrl.startsWith('https://');
    this.production = opts.production ?? process.env.NODE_ENV === 'production';
  }

  cookieFor(token: string) {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttl / 1000)}${this.secure ? '; Secure' : ''}`;
  }
  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`;
  }

  async createSession(ownerId: string) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.ownerSession.create({ data: { id: hash(token), ownerId, expiresAt: new Date(this.now().getTime() + this.ttl) } });
    return { token, cookie: this.cookieFor(token) };
  }

  /** The signed-in owner for this request, or null. */
  async ownerFor(req: IncomingMessage): Promise<{ id: string; email: string } | null> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || token.length > 200) return null;
    const s = await this.prisma.ownerSession.findUnique({ where: { id: hash(token) } });
    if (!s || s.revokedAt || s.expiresAt <= this.now()) return null;
    const owner = await this.prisma.owner.findUnique({ where: { id: s.ownerId }, select: { id: true, email: true } });
    return owner ?? null;
  }

  async logout(req: IncomingMessage) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.prisma.ownerSession.updateMany({ where: { id: hash(token), revokedAt: null }, data: { revokedAt: this.now() } });
    return { cookie: this.clearCookie() };
  }

  /**
   * Ask for a sign-in link. The response is the same whether or not the email has an account (no account
   * enumeration), except that dev builds without a mailer return the link itself so the flow is testable.
   */
  async requestLink(emailRaw: unknown, next?: unknown, devOrigin?: string): Promise<{ sent: true; devLink?: string; devNote?: string }> {
    const email = String(emailRaw ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new Error('INVALID_EMAIL');
    if (!this.opts.deliver && this.production) throw new Error('LOGIN_EMAIL_NOT_CONFIGURED');
    const owner = await this.prisma.owner.findUnique({ where: { email } });
    if (!owner) return this.opts.deliver ? { sent: true } : { sent: true, devNote: 'No PayPali account uses this email. Sign up instead.' };
    const token = randomBytes(32).toString('base64url');
    await this.prisma.loginLink.create({
      data: { id: hash(token), ownerId: owner.id, next: safeNext(next), expiresAt: new Date(this.now().getTime() + this.linkTtl) },
    });
    // Emailed links always use the public URL; dev links use the origin the person is browsing, if it is local.
    const base = !this.opts.deliver && devOrigin && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(devOrigin) ? devOrigin : this.opts.publicUrl;
    const link = `${base.replace(/\/+$/, '')}/auth/verify?token=${encodeURIComponent(token)}`;
    if (this.opts.deliver) { await this.opts.deliver(email, link); return { sent: true }; }
    process.stdout.write(`[auth] dev sign-in link for ${email}: ${link}\n`);
    return { sent: true, devLink: link };
  }

  /** Redeem a sign-in link exactly once. */
  async verifyLink(token: unknown) {
    const t = String(token ?? '');
    if (!t || t.length > 200) throw new Error('LOGIN_LINK_INVALID');
    const id = hash(t);
    const used = await this.prisma.loginLink.updateMany({ where: { id, usedAt: null, expiresAt: { gt: this.now() } }, data: { usedAt: this.now() } });
    if (used.count !== 1) throw new Error('LOGIN_LINK_INVALID');
    const link = await this.prisma.loginLink.findUniqueOrThrow({ where: { id } });
    const s = await this.createSession(link.ownerId);
    return { ownerId: link.ownerId, next: safeNext(link.next), cookie: s.cookie };
  }

  /** Onboarding: sign in a brand-new owner, or keep the current session if it is the same owner. */
  async afterOnboarding(req: IncomingMessage, ownerId: string, ownerExisted: boolean) {
    const current = await this.ownerFor(req);
    if (current?.id === ownerId) return { signedIn: true as const, cookie: null };
    if (!ownerExisted) { const s = await this.createSession(ownerId); return { signedIn: true as const, cookie: s.cookie }; }
    return { signedIn: false as const, cookie: null };
  }
}
