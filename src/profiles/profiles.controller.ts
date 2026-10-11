import { Controller, Get, Patch, Post, Put, Body, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ProfilesService } from './profiles.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me')
  async getMe(@Req() req: any) {
    return this.profilesService.getProfile(req.user?.userId || '');
  }

  @Patch('me')
  async updateMe(@Req() req: any, @Body() dto: any) {
    return this.profilesService.updateProfile(req.user?.userId || '', dto);
  }

  @Get('me/history')
  async getHistory(@Req() req: any, @Query('limit') limit?: string) {
    return this.profilesService.getHistory(req.user?.userId || '', limit);
  }

  @Post('me/history')
  async recordPlay(@Req() req: any, @Body() dto: any) {
    return this.profilesService.recordPlay(req.user?.userId || '', dto);
  }

  @Get('me/library')
  async getLibrary(@Req() req: any) {
    return this.profilesService.getLibrary(req.user?.userId || '');
  }

  // Full-state union sync can carry large bodies — throttle per user.
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Put('me/library')
  async syncLibrary(@Req() req: any, @Body() dto: any) {
    return this.profilesService.syncLibrary(req.user?.userId || '', dto);
  }
}
