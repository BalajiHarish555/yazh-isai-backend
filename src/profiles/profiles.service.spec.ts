import { describe, expect, it } from 'vitest';
import { ProfilesService } from './profiles.service';

describe('ProfilesService library helpers (no database)', () => {
  const svc = new ProfilesService({} as any);

  it('parses stored snapshots and tolerates garbage', () => {
    expect((svc as any).parseLibrary(null)).toEqual({ liked: [], playlists: [] });
    expect((svc as any).parseLibrary('{{{')).toEqual({ liked: [], playlists: [] });
    expect(
      (svc as any).parseLibrary(JSON.stringify({ liked: [{ id: 'a' }], playlists: 'nope' })),
    ).toEqual({ liked: [{ id: 'a' }], playlists: [] });
  });

  it('sanitizes songs: keeps shape, drops junk, caps lengths', () => {
    expect((svc as any).sanitizeSong(null)).toBeNull();
    expect((svc as any).sanitizeSong({ noId: true })).toBeNull();
    const clean = (svc as any).sanitizeSong({
      id: 'x',
      title: 'T',
      artist: 'A',
      albumArt: 'http://img',
      evil: '<script>',
    });
    expect(clean).toEqual({ id: 'x', title: 'T', artist: 'A', albumArt: 'http://img' });
    expect((clean as any).evil).toBeUndefined();
  });
});
