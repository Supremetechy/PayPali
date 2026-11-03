import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SessionService, SESSION_COOKIE, safeNext } from '../src/auth/SessionService';
import { createTestDb, TestDb } from './harness';

let db: TestDb, prisma: PrismaClient, s: SessionService, clock: number;
const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as any;
const cookieVal = (setCookie: string) => setCookie.split(';')[0];   // "pp_session=…"

beforeEach(async () => {
  db = await createTestDb(); prisma = db.prisma; clock = Date.now();
  s = new SessionService(prisma, { publicUrl: 'http://localhost:4000', production: false, now: () => new Date(clock) });
});
afterEach(async () => db.close());
const owner = (email = `o_${randomUUID()}@example.com`) => prisma.owner.create({ data: { email } });

describe('owner sessions', () => {
  it('a session cookie identifies the owner; logout revokes it; only the token hash is stored', async () => {
    const o = await owner();
    const { token, cookie } = await s.createSession(o.id);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=.+; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    expect(await s.ownerFor(req(cookieVal(cookie)))).toEqual({ id: o.id, email: o.email });
    expect(await s.ownerFor(req('other=1; ' + cookieVal(cookie) + '; x=2'))).toMatchObject({ id: o.id });
    expect(JSON.stringify(await prisma.ownerSession.findMany())).not.toContain(token);
    expect(await s.ownerFor(req())).toBeNull();
    expect(await s.ownerFor(req(`${SESSION_COOKIE}=forged`))).toBeNull();
    const out = await s.logout(req(cookieVal(cookie)));
    expect(out.cookie).toContain('Max-Age=0');
    expect(await s.ownerFor(req(cookieVal(cookie)))).toBeNull();
  });

  it('sessions expire', async () => {
    const o = await owner();
    const { cookie } = await s.createSession(o.id);
    clock += 31 * 86_400_000;
    expect(await s.ownerFor(req(cookieVal(cookie)))).toBeNull();
  });

  it('uses Secure cookies on an https origin', async () => {
    const o = await owner();
    const https = new SessionService(prisma, { publicUrl: 'https://paypali.example' });
    expect((await https.createSession(o.id)).cookie).toMatch(/; Secure$/);
  });
});

describe('email sign-in links', () => {
  it('dev: returns a single-use link that signs in and redirects to a same-site next', async () => {
    const o = await owner('Ada@Example.com'.toLowerCase());
    const r = await s.requestLink('  ADA@example.com ', '/marketplace#explore');
    expect(r.devLink).toMatch(/^http:\/\/localhost:4000\/auth\/verify\?token=/);
    const token = new URL(r.devLink!).searchParams.get('token')!;
    const v = await s.verifyLink(token);
    expect(v).toMatchObject({ ownerId: o.id, next: '/marketplace#explore' });
    expect(await s.ownerFor(req(cookieVal(v.cookie)))).toMatchObject({ id: o.id });
    await expect(s.verifyLink(token)).rejects.toThrow('LOGIN_LINK_INVALID');   // single use
  });

  it('dev links open on the local host the person is using; emailed links always use the public URL', async () => {
    await owner('host@example.com');
    expect((await s.requestLink('host@example.com', '/', 'http://127.0.0.1:4000')).devLink).toMatch(/^http:\/\/127\.0\.0\.1:4000\/auth\/verify\?token=/);
    expect((await s.requestLink('host@example.com', '/', 'https://evil.example')).devLink).toMatch(/^http:\/\/localhost:4000\//);
    const sent: string[] = [];
    const mailer = new SessionService(prisma, { publicUrl: 'https://pp.example', deliver: async (_e, l) => { sent.push(l); } });
    await mailer.requestLink('host@example.com', '/', 'http://127.0.0.1:4000');
    expect(sent[0]).toMatch(/^https:\/\/pp\.example\//);
  });

  it('links expire after 15 minutes', async () => {
    await owner('late@example.com');
    const token = new URL((await s.requestLink('late@example.com')).devLink!).searchParams.get('token')!;
    clock += 16 * 60_000;
    await expect(s.verifyLink(token)).rejects.toThrow('LOGIN_LINK_INVALID');
  });

  it('does not reveal accounts when a mailer is configured; refuses in production without one', async () => {
    const sent: string[] = [];
    const mailer = new SessionService(prisma, { publicUrl: 'https://pp.example', deliver: async (e, l) => { sent.push(e + ' ' + l); } });
    await owner('known@example.com');
    expect(await mailer.requestLink('known@example.com')).toEqual({ sent: true });
    expect(await mailer.requestLink('unknown@example.com')).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^known@example\.com https:\/\/pp\.example\/auth\/verify\?token=/);
    const prod = new SessionService(prisma, { publicUrl: 'https://pp.example', production: true });
    await expect(prod.requestLink('known@example.com')).rejects.toThrow('LOGIN_EMAIL_NOT_CONFIGURED');
    await expect(s.requestLink('not-an-email')).rejects.toThrow('INVALID_EMAIL');
  });

  it('only same-site paths are accepted as next (no open redirect)', () => {
    expect(safeNext('/dashboard?agent=1')).toBe('/dashboard?agent=1');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/a\r\nSet-Cookie: x', '', null]) expect(safeNext(bad)).toBe('/dashboard');
  });
});

describe('onboarding sign-in', () => {
  it('signs in a brand-new owner, keeps the same owner signed in, never signs in an existing email', async () => {
    const o = await owner();
    const fresh = await s.afterOnboarding(req(), o.id, false);
    expect(fresh.signedIn).toBe(true);
    expect(fresh.cookie).toContain(SESSION_COOKIE + '=');
    const again = await s.afterOnboarding(req(cookieVal(fresh.cookie!)), o.id, true);
    expect(again).toEqual({ signedIn: true, cookie: null });
    const stranger = await s.afterOnboarding(req(), o.id, true);   // someone typed an existing email
    expect(stranger).toEqual({ signedIn: false, cookie: null });
    const other = await owner();
    const otherSession = await s.createSession(other.id);
    expect((await s.afterOnboarding(req(cookieVal(otherSession.cookie)), o.id, true)).signedIn).toBe(false);
  });
});
