import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Inject } from '@nestjs/common';

@Injectable()
export class AuthService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jwtService: JwtService,
  ) {}

  async register(dto: any) {
    const { email, username, password } = dto;

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
    const { email, password } = dto;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, email: user.email, role: user.role };

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: this.jwtService.sign({ sub: user.id }, { expiresIn: '7d' }),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    };
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
