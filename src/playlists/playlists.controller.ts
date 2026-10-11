import { Controller, Get, Post, Patch, Put, Delete, Body, Param, UseGuards, Req, HttpException, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PlaylistsService } from './playlists.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('playlists')
export class PlaylistsController {
  constructor(private readonly playlistsService: PlaylistsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() dto: any, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.create(userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.findAll(userId);
  }

  // Public share link — NO guard. Declared before ':id' so 'share'
  // isn't swallowed as an id.
  @Get('share/:id')
  async getShare(@Param('id') id: string) {
    const share = await this.playlistsService.getShare(id);
    if (!share) {
      throw new HttpException({ error: 'Shared playlist not found' }, HttpStatus.NOT_FOUND);
    }
    return share;
  }

  @UseGuards(JwtAuthGuard)
  @Post('share')
  async publishShare(@Body() dto: any, @Req() req: any) {
    return this.playlistsService.publishShare(req.user?.userId || '', dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('share/:id')
  async deleteShare(@Param('id') id: string, @Req() req: any) {
    return this.playlistsService.deleteShare(id, req.user?.userId || '');
  }

  // Collaborative edit — public route, capability-checked via editKey.
  // Declared before ':id' so it can't be swallowed (different prefix anyway).
  // Throttled: the 32-hex editKey must not be brute-forceable at line speed.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Put('share/:id/tracks')
  async updateSharedTracks(@Param('id') id: string, @Body() dto: any) {
    const result = await this.playlistsService.updateSharedTracks(id, dto?.editKey, dto?.tracks);
    if (!result.updated) {
      const code = result.reason === 'invalid edit key' ? HttpStatus.FORBIDDEN : HttpStatus.NOT_FOUND;
      throw new HttpException({ error: result.reason || 'Update failed' }, code);
    }
    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.findOne(id, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/tracks')
  async addTrack(@Param('id') id: string, @Body('trackId') trackId: string, @Body('position') position: number, @Req() req: any) {
    return this.playlistsService.addTrack(req.user?.userId || '', id, trackId, position);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/tracks/:trackId')
  async removeTrack(@Param('id') id: string, @Param('trackId') trackId: string, @Req() req: any) {
    return this.playlistsService.removeTrack(req.user?.userId || '', id, trackId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.update(id, userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.delete(id, userId);
  }
}
