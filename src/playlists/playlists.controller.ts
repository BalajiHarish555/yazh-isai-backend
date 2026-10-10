import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
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

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId || '';
    return this.playlistsService.findOne(id, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/tracks')
  async addTrack(@Param('id') id: string, @Body('trackId') trackId: string, @Body('position') position: number) {
    return this.playlistsService.addTrack(id, trackId, position);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/tracks/:trackId')
  async removeTrack(@Param('id') id: string, @Param('trackId') trackId: string) {
    return this.playlistsService.removeTrack(id, trackId);
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
