import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ArtistsService } from './artists.service';

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

  @Post()
  async create(@Body() dto: any) {
    return this.artistsService.create(dto);
  }
}
