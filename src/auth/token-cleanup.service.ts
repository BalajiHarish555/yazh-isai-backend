import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Purges spent refresh tokens so the table can't grow forever. Revoked and
 * expired rows are equally useless for reuse detection (both answer 401),
 * so deleting them loses no security signal.
 */
@Injectable()
export class TokenCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  onModuleInit() {
    setTimeout(() => this.sweep().catch(() => undefined), 60_000);
    this.timer = setInterval(() => {
      this.sweep().catch(() => undefined);
    }, 6 * 60 * 60 * 1000);
    const t: any = this.timer;
    if (t && typeof t.unref === 'function') t.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep() {
    try {
      const res = await this.prisma.refreshToken.deleteMany({
        where: { OR: [{ revoked: true }, { expiresAt: { lt: new Date() } }] },
      });
      if (res.count > 0) {
        this.logger.log(`Purged ${res.count} stale refresh tokens`);
      }
    } catch (err: any) {
      this.logger.warn(`Token purge failed: ${err?.message || err}`);
    }
  }
}
