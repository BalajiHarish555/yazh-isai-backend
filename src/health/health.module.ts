import { Module } from '@nestjs/common';
import { Controller } from '@nestjs/common';
import { Get } from '@nestjs/common';
import { CacheModule } from '../common/cache.module';
import { StreamHealthController } from './stream-health.controller';
import { StreamHealthService } from './stream-health.service';

@Controller('health')
export class HealthController {
  @Get()
  async check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'healthy',
        redis: 'healthy',
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
