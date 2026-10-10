import { Controller, Get, Query, Param, UseGuards, Req } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly recService: RecommendationService,
    private readonly moodEngine: MoodEngineService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('home')
  async getHome(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.recService.getPersonalizedHome(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mood/:id/tracks')
  async getMoodTracks(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.recService.recommendByMood(userId, id);
  }

  @Get('moods')
  async getAvailableMoods() {
    return this.moodEngine.getAllMoods();
  }
}
