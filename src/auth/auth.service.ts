import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { Inject } from '@nestjs/common';

@Injectable()
export class AuthService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jwtService: JwtService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async register(dto: any) {
    const email = typeof dto?.email === 'string' ? dto.email.trim() : '';
    const username = typeof dto?.username === 'string' ? dto.username.trim() : '';
    const { password } = dto || {};
    if (!email || !username) {
      throw new BadRequestException('Email and username are required');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });

    if (existingUser) {
      throw new ConflictException('Email or username already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        profile: {
          create: { displayName: username },
        },
        preferences: {
          create: {
            preferredGenres: JSON.stringify([]),
            preferredArtists: JSON.stringify([]),
            preferredMoods: JSON.stringify([]),
            preferredLanguages: JSON.stringify([]),
          },
        },
      },
    });

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  async login(dto: any) {
    const { email, identifier, password } = dto;
    const loginId = identifier || email;
    if (!loginId || typeof loginId !== 'string') {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (typeof password !== 'string' || !password) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: loginId }, { username: loginId }] },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, email: user.email, role: user.role };
    // jti guarantees every refresh token is unique, even when two are
    // minted within the same second (JWT iat has 1s resolution — without
    // this, rapid rotation produces byte-identical tokens that collide on
    // the hashedToken unique constraint).
    const refreshToken = this.jwtService.sign({ sub: user.id, jti: randomUUID() }, { expiresIn: '7d' });

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        hashedToken: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new UnauthorizedException('Refresh token required');
    }

    try {
      return await this.rotateRefreshToken(refreshToken);
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      console.error('refresh FAILED:', err?.stack || err);
      throw err;
    }
  }

  private async rotateRefreshToken(refreshToken: string) {
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Refresh tokens carry only sub; access tokens carry email. Refuse to
    // "refresh" from an access token so the two can't be interchanged.
    if (!payload?.sub || typeof payload.sub !== 'string' || payload.email) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    let user: any = null;
    try {
      user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    } catch {
      // Malformed sub (e.g. non-UUID) fails Prisma validation — still a 401.
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Atomically consume the presented token: exactly one concurrent
    // rotation can flip revoked:false -> true, so a replayed token finds
    // zero rows and gets a 401 instead of a second fresh pair.
    const consumed = await this.prisma.refreshToken.updateMany({
      where: {
        hashedToken: this.hashToken(refreshToken),
        userId: user.id,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      data: { revoked: true },
    });
    if (consumed.count === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const newRefreshToken = this.jwtService.sign({ sub: user.id, jti: randomUUID() }, { expiresIn: '7d' });
    const hashedNewToken = this.hashToken(newRefreshToken);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        hashedToken: hashedNewToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });
    
    const newPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: this.jwtService.sign(newPayload),
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    };
  }

  async logout(userId: string, refreshToken?: string) {
    // Revoke the presented token, or every active token for the user when
    // none is presented (e.g. access already expired). Always succeeds —
    // logout must never leak whether a token was valid.
    try {
      if (refreshToken && typeof refreshToken === 'string') {
        await this.prisma.refreshToken.updateMany({
          where: { userId, hashedToken: this.hashToken(refreshToken) },
          data: { revoked: true },
        });
      } else {
        await this.prisma.refreshToken.updateMany({
          where: { userId, revoked: false },
          data: { revoked: true },
        });
      }
    } catch {
      // ignore — client state is cleared regardless
    }
    return { loggedOut: true };
  }

  async getMe(userId: string) {
    // NOTE: never return passwordHash — it used to leak through this route.
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
        profile: true,
        preferences: true,
      },
    });
  }
}
