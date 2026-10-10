import { Controller, Get, Post, Delete, Param, UseGuards, Req } from '@nestjs/common';
import { LibraryService } from './library.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @UseGuards(JwtAuthGuard)
  @Post('tracks/:id/like')
  async likeTrack(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.likeTrack(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('tracks/:id/like')
  async unlikeTrack(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.unlikeTrack(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('tracks')
  async getLikedTracks(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.getLikedTracks(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('artists/:id/follow')
  async followArtist(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.followArtist(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('artists/:id/follow')
  async unfollowArtist(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.unfollowArtist(userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('artists')
  async getFollowedArtists(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.libraryService.getFollowedArtists(userId);
  }
}
