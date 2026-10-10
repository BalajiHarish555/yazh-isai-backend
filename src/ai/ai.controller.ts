import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { AIService } from './ai.service';
import { RecommendationService } from '../discovery/recommendation.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('ai')
export class AIController {
  constructor(
    private readonly aiService: AIService,
    private readonly recService: RecommendationService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('discover')
  async discover(@Body('prompt') prompt: string, @Req() req: any) {
    // 1. Use AI to interpret the intent
    const intent = await this.aiService.interpretIntent(prompt);
    
    // 2. Use the intent to filter tracks via the Recommendation Engine
    // We use the first suggested mood for the stream
    const primaryMood = intent.moods[0];
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
    // 1. AI generates the concept
    const concept = await this.aiService.generatePlaylistConcept(prompt);
    
    // 2. Recommendation engine fills the concept with actual tracks
    const userId = req.user?.userId || '';
    const tracks = await this.recService.recommendByMood(userId, concept.suggestedMoods[0]);

    return {
      ...concept,
      tracks,
    };
  }
}
