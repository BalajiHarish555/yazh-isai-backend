import { Controller, Post, Body, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AIService } from './ai.service';
import { RecommendationService } from '../discovery/recommendation.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

function requirePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequestException('A text prompt is required');
  }
  return prompt.trim().slice(0, 1000);
}

// Each call fans out to AI + recommendation queries.
@Throttle({ default: { limit: 20, ttl: 60000 } })
@Controller('ai')
export class AIController {
  constructor(
    private readonly aiService: AIService,
    private readonly recService: RecommendationService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('discover')
  async discover(@Body('prompt') prompt: string, @Req() req: any) {
    const clean = requirePrompt(prompt);
    // 1. Use AI to interpret the intent
    const intent = await this.aiService.interpretIntent(clean);

    // 2. Use the intent to filter tracks via the Recommendation Engine.
    // recommendByMood falls back to 'chill' for missing/garbage moods.
    const primaryMood = Array.isArray(intent?.moods) && intent.moods[0] ? intent.moods[0] : 'chill';
    const userId = req.user?.userId || '';
    const tracks = await this.recService.recommendByMood(userId, primaryMood);

    return {
      intent,
      tracks,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('playlists')
  async generatePlaylist(@Body('prompt') prompt: string, @Req() req: any) {
    const clean = requirePrompt(prompt);
    // 1. AI generates the concept
    const concept = await this.aiService.generatePlaylistConcept(clean);

    // 2. Recommendation engine fills the concept with actual tracks
    const userId = req.user?.userId || '';
    const moods = Array.isArray((concept as any)?.suggestedMoods) ? (concept as any).suggestedMoods : [];
    const tracks = await this.recService.recommendByMood(userId, moods[0] || 'chill');

    return {
      ...concept,
      tracks,
    };
  }
}
