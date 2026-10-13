import { Controller, Get, Query, Param, UseGuards, Req } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';
import { TasteProfileService } from './taste-profile.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly recService: RecommendationService,
    private readonly moodEngine: MoodEngineService,
    private readonly tasteService: TasteProfileService,
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

  @UseGuards(JwtAuthGuard)
  @Get('taste')
  async getTaste(@Req() req: any, @Query('limit') limit?: string) {
    const userId = req.user?.userId || '';
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(30, Math.floor(Number(limit)))) : 12;
    return this.tasteService.buildUpNext(userId, n);
  }

  @UseGuards(JwtAuthGuard)
  @Get('taste')
  async getTaste(@Req() req: any, @Query('limit') limit?: string) {
    const userId = req.user?.userId || '';
    return this.tasteService.getTasteForUser(userId, limit ? parseInt(limit, 10) : 20);
  }
}
