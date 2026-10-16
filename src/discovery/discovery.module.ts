import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';
import { TasteProfileService } from './taste-profile.service';
import { ReelsFeedService } from './reels-feed.service';
import { ReelSessionService } from './reels-session.service';
import { TracksModule } from '../catalog/tracks/tracks.module';

@Module({
  imports: [TracksModule],
  controllers: [DiscoveryController],
  providers: [
    RecommendationService,
    MoodEngineService,
    TasteProfileService,
    ReelsFeedService,
    ReelSessionService,
  ],
  exports: [
    RecommendationService,
    MoodEngineService,
    TasteProfileService,
    ReelsFeedService,
    ReelSessionService,
  ],
})
export class DiscoveryModule {}
