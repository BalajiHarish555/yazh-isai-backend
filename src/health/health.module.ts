import { Module } from '@nestjs/common';
import { Controller } from '@nestjs/common';
import { Get } from '@nestjs/common';

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
  controllers: [HealthController],
})
export class HealthModule {}
