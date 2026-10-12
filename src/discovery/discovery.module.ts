import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';
import { TasteProfileService } from './taste-profile.service';

@Module({
  controllers: [DiscoveryController],
  providers: [RecommendationService, MoodEngineService, TasteProfileService],
  exports: [RecommendationService, MoodEngineService, TasteProfileService],
})
export class DiscoveryModule {}
