import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ArtistsService } from './artists.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

@Controller('artists')
export class ArtistsController {
  constructor(private readonly artistsService: ArtistsService) {}

  @Get()
  async findAll() {
    return this.artistsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.artistsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() dto: any) {
    return this.artistsService.create(dto);
  }
}
