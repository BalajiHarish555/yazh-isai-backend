import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class LibraryService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async likeTrack(userId: string, trackId: string) {
    // External/YouTube ids have no catalog row — reject with 404 instead of
    // letting the FK throw a raw 500.
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      select: { id: true },
    });
    if (!track) throw new NotFoundException('Track not found in catalog');
    return this.prisma.likedTrack.upsert({
      where: { userId_trackId: { userId, trackId } },
      update: {},
      create: { userId, trackId },
    });
  }

  async unlikeTrack(userId: string, trackId: string) {
    const res = await this.prisma.likedTrack.deleteMany({
      where: { userId, trackId },
    });
    return { removed: res.count > 0 };
  }

  async getLikedTracks(userId: string) {
    const liked = await this.prisma.likedTrack.findMany({
      where: { userId },
      include: { track: { include: { artists: { include: { artist: true } } } } },
    });
    return liked.map((lt: any) => lt.track).filter(Boolean);
  }

  async followArtist(userId: string, artistId: string) {
    const artist = await this.prisma.artist.findUnique({
      where: { id: artistId },
      select: { id: true },
    });
    if (!artist) throw new NotFoundException('Artist not found');
    return this.prisma.followedArtist.upsert({
      where: { userId_artistId: { userId, artistId } },
      update: {},
      create: { userId, artistId },
    });
  }

  async unfollowArtist(userId: string, artistId: string) {
    const res = await this.prisma.followedArtist.deleteMany({
      where: { userId, artistId },
    });
    return { removed: res.count > 0 };
  }

  async getFollowedArtists(userId: string) {
    const followed = await this.prisma.followedArtist.findMany({
      where: { userId },
      include: { artist: true },
    });
    return followed.map((fa: any) => fa.artist).filter(Boolean);
  }
}
