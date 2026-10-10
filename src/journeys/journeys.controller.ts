import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { JourneysService } from './journeys.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('journeys')
export class JourneysController {
  constructor(private readonly journeysService: JourneysService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async createJourney(@Body() dto: any, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.journeysService.createJourney(userId, dto);
  }

  @Get('suggestions')
  async getSuggestions() {
    return this.journeysService.getSuggestedJourneys();
  }
}
