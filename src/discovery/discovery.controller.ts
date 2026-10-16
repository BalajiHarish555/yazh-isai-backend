import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { MoodEngineService } from './mood-engine.service';
import { TasteProfileService } from './taste-profile.service';
import { ReelsFeedService } from './reels-feed.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly recService: RecommendationService,
    private readonly moodEngine: MoodEngineService,
    private readonly tasteService: TasteProfileService,
    private readonly reels: ReelsFeedService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('home')
  async getHome(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.recService.getPersonalizedHome(userId);
  }

  // Reels feed: optional auth — personalized when a token is present,
  // anonymous otherwise (req.user stays unset — never dereferenced blindly).
  // 'reels' is a stable alias of 'feed' so both documented paths resolve.
  @UseGuards(OptionalJwtAuthGuard)
  @Get(['feed', 'reels'])
  async getFeed(
    @Req() req: any,
    @Query('mood') mood?: string,
    @Query('lang') lang?: string,
    @Query('limit') limit?: string,
    @Query('seed') seed?: string,
  ) {
    const userId = req.user?.userId || '';
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.reels.getFeed({ mood, lang, limit: parsedLimit, seed, userId });
  }

  // Personalised "For You" home feed — taste-ranked, discovery-mixed.
  // Optional auth: personalised when a token is present, popular otherwise.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('for-you')
  async getForYou(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('seed') seed?: string,
  ) {
    const userId = req.user?.userId || '';
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.reels.getForYou({ limit: parsedLimit, seed, userId });
  }

  @UseGuards(JwtAuthGuard)
  @Post('events')
  async postEvents(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || '';
    return this.reels.recordEvents(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('preferences')
  async getPreferences(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.reels.getPreferences(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put('preferences')
  async updatePreferences(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || '';
    return this.reels.updatePreferences(userId, body);
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
    return this.tasteService.getTasteForUser(userId, limit ? parseInt(limit, 10) : 20);
  }
}
