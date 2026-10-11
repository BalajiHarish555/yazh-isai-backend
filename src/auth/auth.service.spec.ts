import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';

// Live-database spec: exercises refresh-token rotation + revocation against
// the Postgres from DATABASE_URL (local: `npm run db:start`). Pure-logic
// helpers are covered by the other spec files; this one guards the flow
// that actually protects sessions.
describe('AuthService refresh rotation (live database)', () => {
  const prisma = new PrismaClient();
  const svc = new AuthService(
    prisma as any,
    new JwtService({ secret: 'test-secret-for-unit-tests-only' }) as any,
  );
  const tag = Date.now();
  const email = `spectest${tag}@mail.com`;
  const username = `spectest${tag}`;
  const password = 'SpecTest123!';
  let userId = '';

  beforeAll(async () => {
    await svc.register({ email, username, password });
    const me = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = me.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('login stores a usable refresh token', async () => {
    const out = await svc.login({ email, password });
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).toBeTruthy();
    const rows = await prisma.refreshToken.findMany({ where: { userId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked === false)).toBe(true);
  });

  it('refresh rotates the pair and kills the old token', async () => {
    const first = await svc.login({ email, password });
    const rotated = await svc.refresh(first.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    // Old token is now dead.
    await expect(svc.refresh(first.refreshToken)).rejects.toThrow();
    // New token chains forward.
    const again = await svc.refresh(rotated.refreshToken);
    expect(again.accessToken).toBeTruthy();
  });

  it('rejects access tokens and garbage as refresh tokens', async () => {
    const out = await svc.login({ email, password });
    await expect(svc.refresh(out.accessToken)).rejects.toThrow();
    await expect(svc.refresh('garbage')).rejects.toThrow();
    await expect(svc.refresh('')).rejects.toThrow();
  });

  it('logout revokes the session token', async () => {
    const out = await svc.login({ email, password });
    await svc.logout(userId, out.refreshToken);
    await expect(svc.refresh(out.refreshToken)).rejects.toThrow();
  });
});
