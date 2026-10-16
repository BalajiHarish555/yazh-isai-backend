import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { sanitizeHistoryEvent, sanitizeSearchQueries } from '../discovery/taste-profile.service';

const PROFILE_FIELDS = [
  'displayName',
  'avatarUrl',
  'bio',
  'country',
  'preferredLanguage',
] as const;

@Injectable()
export class ProfilesService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
        profile: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [likedTracks, likedAlbums, playlists, followedArtists, totalPlays] =
      await Promise.all([
        this.prisma.likedTrack.count({ where: { userId } }),
        this.prisma.likedAlbum.count({ where: { userId } }),
        this.prisma.playlist.count({ where: { ownerId: userId } }),
        this.prisma.followedArtist.count({ where: { userId } }),
        this.prisma.listeningEvent.count({ where: { userId } }),
      ]);

    return {
      ...user,
      memberSince: user.createdAt,
      stats: { likedTracks, likedAlbums, playlists, followedArtists, totalPlays },
    };
  }

  async updateProfile(userId: string, dto: any) {
    const data: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) {
      if (typeof dto?.[field] === 'string') {
        data[field] = dto[field].slice(0, 500);
      }
    }
    if (Object.keys(data).length === 0) {
      return this.prisma.profile.findUnique({ where: { userId } });
    }
    return this.prisma.profile.upsert({
      where: { userId },
      update: data,
      create: { userId, displayName: data.displayName || 'Music Fan', ...data },
    });
  }

  private parseLibrary(raw: string | null): { liked: any[]; playlists: any[] } {
    if (!raw) return { liked: [], playlists: [] };
    try {
      const parsed = JSON.parse(raw);
      return {
        liked: Array.isArray(parsed?.liked) ? parsed.liked : [],
        playlists: Array.isArray(parsed?.playlists) ? parsed.playlists : [],
      };
    } catch {
      return { liked: [], playlists: [] };
    }
  }

  private sanitizeSong(s: any): any | null {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string') return null;
    return {
      id: s.id,
      title: s.title.slice(0, 200),
      artist: typeof s.artist === 'string' ? s.artist.slice(0, 200) : '',
      album: typeof s.album === 'string' ? s.album.slice(0, 200) : undefined,
      albumArt: typeof s.albumArt === 'string' ? s.albumArt.slice(0, 500) : '',
      streamUrl: typeof s.streamUrl === 'string' ? s.streamUrl.slice(0, 1000) : undefined,
      source: typeof s.source === 'string' ? s.source.slice(0, 50) : undefined,
      duration: typeof s.duration === 'number' ? s.duration : undefined,
    };
  }

  /**
   * Cross-device library sync. The client sends its full local state; the
   * server unions it with what's stored (dedupe by song/playlist id, sane
   * caps) and returns the merged result both sides converge on.
   */
  async syncLibrary(userId: string, dto: any) {
    const incoming = this.parseLibrary(
      typeof dto?.library === 'string' ? dto.library : JSON.stringify(dto || {}),
    );

    const stored = await this.prisma.profile.findUnique({
      where: { userId },
      select: { library: true },
    });
    const current = this.parseLibrary(stored?.library || null);

    const mergeSongs = (a: any[], b: any[]) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const s of [...a, ...b]) {
        const clean = this.sanitizeSong(s);
        if (clean && !seen.has(clean.id)) {
          seen.add(clean.id);
          out.push(clean);
        }
        if (out.length >= 500) break;
      }
      return out;
    };

    const seenPlaylists = new Set<string>();
    const playlists: any[] = [];
    for (const p of [...current.playlists, ...incoming.playlists]) {
      const id = typeof p?.id === 'string' ? p.id : '';
      if (!id || seenPlaylists.has(id)) continue;
      seenPlaylists.add(id);
      playlists.push({
        id,
        name: typeof p?.name === 'string' ? p.name.slice(0, 100) : 'Untitled Playlist',
        tracks: mergeSongs(p?.tracks || [], []),
        createdAt: typeof p?.createdAt === 'number' ? p.createdAt : Date.now(),
      });
      if (playlists.length >= 50) break;
    }

    const merged = { liked: mergeSongs(current.liked, incoming.liked), playlists };
    await this.prisma.profile.upsert({
      where: { userId },
      update: { library: JSON.stringify(merged) },
      create: { userId, displayName: 'Music Fan', library: JSON.stringify(merged) },
    });
    return merged;
  }

  async getLibrary(userId: string) {
    const stored = await this.prisma.profile.findUnique({
      where: { userId },
      select: { library: true },
    });
    return this.parseLibrary(stored?.library || null);
  }

  async getHistory(userId: string, limit: string | number = 20) {
    const take = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.prisma.listeningEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async recordPlay(userId: string, dto: any) {
    // Snapshot row: external track ids (YouTube/Saavn) are legal here —
    // what was heard travels with the event instead of a catalog FK.
    const row = sanitizeHistoryEvent(userId, dto);
    if (!row) return { recorded: false, reason: 'trackId and title are required' };

    const event = await this.prisma.listeningEvent.create({ data: row as any });

    // Bounded retention: age-prune always; hard-cap the per-user tail so a
    // heavy listener never grows the table without bound.
    const cutoff = Date.now() - 180 * 86400000;
    const [old, capAnchor] = await Promise.all([
      this.prisma.listeningEvent.findFirst({
        where: { userId, createdAt: { lt: new Date(cutoff) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.listeningEvent.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: 500,
        select: { createdAt: true },
      }),
    ]);
    const or: any[] = [];
    if (old) or.push({ createdAt: { lt: new Date(cutoff) } });
    if (capAnchor) or.push({ createdAt: { lte: capAnchor.createdAt } });
    if (or.length > 0) {
      await this.prisma.listeningEvent
        .deleteMany({ where: { userId, OR: or } })
        .catch(() => undefined);
    }

    return { recorded: true, event };
  }

  async recordSearches(userId: string, dto: any) {
    const queries = sanitizeSearchQueries(dto?.queries);
    if (queries.length === 0) return { recorded: 0 };
    await this.prisma.searchIntent.createMany({
      data: queries.map((query) => ({ userId, query })),
    });
    const cutoff = Date.now() - 180 * 86400000;
    await this.prisma.searchIntent
      .deleteMany({ where: { userId, createdAt: { lt: new Date(cutoff) } } })
      .catch(() => undefined);
    return { recorded: queries.length };
  }
}
