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

  /**
   * Follow by catalog id OR artist name — artist pages in this app are
   * name-keyed (external search results), so a name that has no catalog row
   * yet is created as a minimal artist before following. Returns names for
   * the taste engine (artist affinity is name-matched).
   */
  private async resolveArtist(key: string) {
    const raw = typeof key === 'string' ? key.trim().slice(0, 80) : '';
    if (!raw) throw new NotFoundException('Artist not found');
    const byId = await this.prisma.artist.findUnique({
      where: { id: raw },
      select: { id: true, name: true },
    });
    if (byId) return byId;
    const byName = await this.prisma.artist.findFirst({
      where: { name: { equals: raw, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (byName) return byName;
    return this.prisma.artist.create({
      data: { name: raw, genres: '' },
      select: { id: true, name: true },
    });
  }

  async followArtist(userId: string, key: string) {
    const artist = await this.resolveArtist(key);
    await this.prisma.followedArtist.upsert({
      where: { userId_artistId: { userId, artistId: artist.id } },
      update: {},
      create: { userId, artistId: artist.id },
    });
    return { following: true, id: artist.id, name: artist.name };
  }

  async unfollowArtist(userId: string, key: string) {
    const raw = typeof key === 'string' ? key.trim().slice(0, 80) : '';
    if (!raw) return { following: false, removed: false };
    const byId = await this.prisma.artist.findUnique({ where: { id: raw }, select: { id: true, name: true } });
    const artist =
      byId ||
      (await this.prisma.artist.findFirst({
        where: { name: { equals: raw, mode: 'insensitive' } },
        select: { id: true, name: true },
      }));
    if (!artist) return { following: false, removed: false };
    const res = await this.prisma.followedArtist.deleteMany({
      where: { userId, artistId: artist.id },
    });
    return { following: false, removed: res.count > 0, id: artist.id, name: artist.name };
  }

  async getFollowedArtists(userId: string) {
    const followed = await this.prisma.followedArtist.findMany({
      where: { userId },
      include: { artist: true },
    });
    return followed.map((fa: any) => fa.artist).filter(Boolean);
  }

  /** Names only — cheap for the follow-button state check. */
  async getFollowedArtistNames(userId: string): Promise<string[]> {
    const followed = await this.prisma.followedArtist.findMany({
      where: { userId },
      include: { artist: { select: { name: true } } },
      take: 200,
    });
    return followed.map((fa: any) => fa?.artist?.name).filter((n: any) => typeof n === 'string' && !!n);
  }
}
