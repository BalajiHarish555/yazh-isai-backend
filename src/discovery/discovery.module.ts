import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';

@Module({
  controllers: [DiscoveryController],
  providers: [RecommendationService, MoodEngineService],
  exports: [RecommendationService, MoodEngineService],
})
export class DiscoveryModule {}
