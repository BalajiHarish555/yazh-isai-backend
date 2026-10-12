import { Module, Inject } from '@nestjs/common';
import { Controller } from '@nestjs/common';
import { Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CacheModule } from '../common/cache.module';
import { CacheService } from '../common/cache.service';
import { StreamHealthController } from './stream-health.controller';
import { StreamHealthService } from './stream-health.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private cache: CacheService,
  ) {}

  @Get()
  async check() {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1 as ok`
        .then(() => 'healthy')
        .catch(() => 'unhealthy'),
      Promise.resolve(this.cache.isRedisUp() ? 'healthy' : 'fallback'),
    ]);
    return {
      status: database === 'healthy' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      // Deploy marker the app uses to notice a new version without
      // reloading itself mid-song. Render injects RENDER_GIT_COMMIT.
      version:
        (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) ||
        process.env.APP_VERSION ||
        'dev',
      services: {
        database,
        redis,
        ai: 'available',
      },
    };
  }
}

@Module({
  imports: [CacheModule],
  controllers: [HealthController, StreamHealthController],
  providers: [StreamHealthService],
})
export class HealthModule {}
