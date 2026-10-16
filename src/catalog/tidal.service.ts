import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import fetch from 'node-fetch';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CacheService } from '../common/cache.service';

export interface TidalFlacDetails {
  streamUrl: string;
  trackId: string;
  proxyUrl: string;
  bitrate: number;
  codec: string;
  mimeType: string;
  qualityLabel: string;
  quality: 'high' | 'medium' | 'low';
  isLossless: boolean;
  source: string;
  title: string;
  artists: string;
  isEncrypted: boolean;
  fileSize: number;
  duration: number;
  isrc?: string;
}

const TIDAL_AUTH_BASE = 'https://auth.tidal.com/v1';
const TIDAL_API_BASE = 'https://api.tidal.com/v1';
const TIDAL_USER_AGENT = 'TIDAL_ANDROID/1039 okhttp/3.14.9';
const LOGIN_SCOPE = 'r_usr w_usr';
const TOKEN_FILE = '.tidal-tokens.json';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId?: string;
  countryCode?: string;
}

interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

@Injectable()
export class TidalService implements OnModuleInit {
  private readonly logger = new Logger(TidalService.name);

  private clientToken: string | null = null;
  private clientTokenExpiry = 0;
  private userTokens: StoredTokens | null = null;
  private pendingDeviceAuth: DeviceAuthResponse | null = null;
  private warnedMetadataOnly = false;
  private wafFailCount = 0;
  private wafOpenUntil = 0;

  constructor(private cacheService: CacheService) {}

  onModuleInit() {
    this.loadUserTokens();
  }

  isEnabled(): boolean {
    return !!(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET);
  }

  /** Circuit breaker: skip Tidal while the WAF block is active. */
  private wafBlocked(): boolean {
    return Date.now() < this.wafOpenUntil;
  }

  private noteWafFailure(status: number): void {
    if (status !== 403 && status !== 429) return;
    this.wafFailCount++;
    if (this.wafFailCount >= 2) {
      const backoffMs = Math.min(5 * 60 * 1000, 60 * 1000 * 2 ** (this.wafFailCount - 2));
      this.wafOpenUntil = Date.now() + backoffMs;
      this.logger.warn(
        `Tidal WAF blocked (403/429) — skipping Tidal for ${Math.round(backoffMs / 60000)}min (fail #${this.wafFailCount})`,
      );
    }
  }

  private noteWafSuccess(): void {
    this.wafFailCount = 0;
    this.wafOpenUntil = 0;
  }

  async status(): Promise<{ enabled: boolean; loggedIn: boolean; playbackReady: boolean }> {
    const loggedIn = (await this.resolveUserToken()) !== null;
    return { enabled: this.isEnabled(), loggedIn, playbackReady: this.isEnabled() && loggedIn };
  }

  private get clientId(): string {
    return (process.env.TIDAL_CLIENT_ID || '').trim();
  }

  private get clientSecret(): string {
    return (process.env.TIDAL_CLIENT_SECRET || '').trim();
  }

  private tokenFilePath(): string {
    return path.join(process.cwd(), TOKEN_FILE);
  }

  private loadUserTokens(): void {
    try {
      const raw = fs.readFileSync(this.tokenFilePath(), 'utf8');
      const data = JSON.parse(raw) as Partial<StoredTokens>;
      if (data.accessToken && data.refreshToken && data.expiresAt) {
        this.userTokens = data as StoredTokens;
        this.logger.log('Tidal user session restored from disk');
      }
    } catch {
      // No saved session
    }
  }

  private saveUserTokens(): void {
    if (!this.userTokens) return;
    try {
      fs.writeFileSync(this.tokenFilePath(), JSON.stringify(this.userTokens), { mode: 0o600 });
    } catch (err: any) {
      this.logger.warn(`Could not persist Tidal session: ${err?.message || err}`);
    }
  }

  // ------------------------------------------ device-code login (TV flow)

  /**
   * Start a device-code login. Returns the URL the user must open to approve.
   * No redirect URI needed — the user just approves at link.tidal.com.
   */
  async startLogin(): Promise<{ loginUrl: string; userCode: string; expiresIn: number; interval: number }> {
    if (!this.isEnabled()) throw new Error('Tidal credentials are not configured');
    if (!this.clientId) throw new Error('TIDAL_CLIENT_ID is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${TIDAL_AUTH_BASE}/oauth2/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: LOGIN_SCOPE,
      }).toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Device authorization failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as DeviceAuthResponse;
    this.pendingDeviceAuth = data;
    this.logger.log(`Tidal device login started — user code: ${data.userCode}`);

    return {
      loginUrl: data.verificationUriComplete || data.verificationUri || `https://link.tidal.com/${data.userCode}`,
      userCode: data.userCode,
      expiresIn: data.expiresIn || 600,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll the token endpoint until the user approves the device code.
   * Returns tokens when approved, or null while still pending.
   */
  async pollLogin(): Promise<{ ok: boolean; error?: string; loggedIn?: boolean }> {
    const deviceAuth = this.pendingDeviceAuth;
    if (!deviceAuth) {
      return { ok: false, error: 'No login in progress — call GET /tidal/login first' };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${TIDAL_AUTH_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: deviceAuth.deviceCode,
          client_secret: this.clientSecret,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          scope: LOGIN_SCOPE,
        }).toString(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 400) {
        // Still waiting for user approval
        return { ok: true, loggedIn: false };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.pendingDeviceAuth = null;
        return { ok: false, error: `Token poll failed: ${res.status} ${body.slice(0, 200)}` };
      }

      const data = (await res.json()) as any;
      if (!data?.access_token) {
        this.pendingDeviceAuth = null;
        return { ok: false, error: 'Token response had no access token' };
      }

      this.userTokens = {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string) || '',
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      this.pendingDeviceAuth = null;
      this.saveUserTokens();

      // Fetch user identity
      await this.fetchUserIdentity();
      this.logger.log('Tidal user login complete — HiRes playback unlocked');
      return { ok: true, loggedIn: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  private async fetchUserIdentity(): Promise<void> {
    const token = this.userTokens?.accessToken;
    if (!token) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${TIDAL_API_BASE}/sessions`, {
        headers: this.authHeaders(token),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = (await res.json()) as any;
        this.userTokens!.userId = String(data?.userId || '');
        this.userTokens!.countryCode = data?.countryCode || 'US';
        this.saveUserTokens();
      }
    } catch {
      // Non-critical
    }
  }

  logout(): void {
    this.userTokens = null;
    this.pendingDeviceAuth = null;
    try {
      fs.unlinkSync(this.tokenFilePath());
    } catch {
      // Already gone
    }
    this.logger.log('Tidal user session cleared');
  }

  private async refreshUserToken(): Promise<boolean> {
    const t = this.userTokens;
    if (!t?.refreshToken) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${TIDAL_AUTH_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: t.refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token',
        }).toString(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        this.logger.warn(`Tidal token refresh failed: ${res.status}`);
        return false;
      }

      const data = (await res.json()) as any;
      if (!data?.access_token) return false;

      this.userTokens = {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string) || t.refreshToken,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        userId: t.userId,
        countryCode: t.countryCode,
      };
      this.saveUserTokens();
      return true;
    } catch (err: any) {
      this.logger.warn(`Tidal token refresh failed: ${err?.message || err}`);
      return false;
    }
  }

  private async resolveUserToken(): Promise<string | null> {
    const fromEnv = (
      process.env.TIDAL_USER_TOKEN ||
      process.env.TIDAL_ACCESS_TOKEN ||
      ''
    ).trim();
    if (fromEnv) return fromEnv;

    const t = this.userTokens;
    if (!t) return null;

    if (Date.now() > t.expiresAt - 5 * 60 * 1000) {
      const ok = await this.refreshUserToken();
      if (!ok) return null;
    }
    return this.userTokens?.accessToken || null;
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'X-Tidal-Token': this.clientId,
      'User-Agent': TIDAL_USER_AGENT,
      Accept: 'application/json',
    };
  }

  // --------------------------------------- client-credentials (metadata only)

  private async getClientToken(): Promise<string | null> {
    if (this.clientToken && Date.now() < this.clientTokenExpiry) return this.clientToken;
    if (!this.clientId || !this.clientSecret) return null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await fetch(`${TIDAL_AUTH_BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        this.logger.warn(`Tidal client token request failed: ${res.status}`);
        return null;
      }

      const data = (await res.json()) as any;
      if (!data?.access_token) return null;

      this.clientToken = data.access_token as string;
      const expiresIn = Number(data.expires_in) || 3600;
      this.clientTokenExpiry = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
      return this.clientToken;
    } catch (err: any) {
      this.logger.warn(`Tidal client token failed: ${err?.message || err}`);
      return null;
    }
  }

  private async searchTrack(title: string, artist: string): Promise<any | null> {
    if (!title) return null;
    if (this.wafBlocked()) return null;
    const token = await this.resolveUserToken() || await this.getClientToken();
    if (!token) return null;

    const query = `${title} ${artist}`.trim();
    const countryCode = this.userTokens?.countryCode || (process.env.TIDAL_COUNTRY_CODE || 'US').trim() || 'US';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `${TIDAL_API_BASE}/search?query=${encodeURIComponent(query)}&include=tracks&limit=10&countryCode=${encodeURIComponent(countryCode)}`,
        {
          headers: this.authHeaders(token),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);

      if (!res.ok) {
        this.noteWafFailure(res.status);
        this.logger.warn(`Tidal search failed: ${res.status} ${res.statusText}`);
        return null;
      }
      this.noteWafSuccess();

      const data = (await res.json()) as any;
      const tracks: any[] = data?.tracks?.items || [];

      if (!Array.isArray(tracks) || tracks.length === 0) return null;

      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const want = norm(title);
      const pickTitle = (t: any) => t?.title || '';
      const best =
        tracks.find((t: any) => {
          const tt = norm(pickTitle(t));
          return tt && (tt.includes(want) || want.includes(tt));
        }) || tracks[0];

      return {
        id: String(best?.id || ''),
        title: best?.title || title,
        artist: best?.artists?.[0]?.name || artist,
        duration: best?.duration || 0,
        isrc: best?.isrc || undefined,
      };
    } catch (err: any) {
      this.logger.warn(`Tidal search failed: ${err?.message || err}`);
      return null;
    }
  }

  async getBestFlacStream(title: string, artist: string): Promise<TidalFlacDetails | null> {
    if (!this.isEnabled()) return null;
    if (!title) return null;
    if (this.wafBlocked()) return null;

    const userToken = await this.resolveUserToken();
    if (!userToken) {
      if (!this.warnedMetadataOnly) {
        this.warnedMetadataOnly = true;
        this.logger.log('Tidal needs a user login — open GET /tidal/login, approve at link.tidal.com, then GET /tidal/poll');
      }
      return null;
    }

    const track = await this.searchTrack(title, artist);
    if (!track?.id) {
      this.logger.log(`Tidal: no match for "${title}" by "${artist}"`);
      return null;
    }

    const countryCode = this.userTokens?.countryCode || 'US';
    const qualityTiers = ['HI_RES', 'LOSSLESS', 'HIGH'];

    for (const audioQuality of qualityTiers) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const params = new URLSearchParams({
          audioquality: audioQuality,
          playbackmode: 'STREAM',
          assetpresentation: 'FULL',
          prefetch: 'false',
          countryCode,
          limit: '9999',
        });
        const res = await fetch(
          `${TIDAL_API_BASE}/tracks/${encodeURIComponent(track.id)}/playbackinfopostpaywall?${params.toString()}`,
          {
            headers: this.authHeaders(userToken),
            signal: controller.signal,
          },
        );
        clearTimeout(timer);

        if (!res.ok) {
          this.noteWafFailure(res.status);
          this.logger.warn(`Tidal playback failed for ${audioQuality}: ${res.status}`);
          continue;
        }
        this.noteWafSuccess();

        const data = (await res.json()) as any;
        const manifestB64 = data?.manifest;
        if (!manifestB64) {
          this.logger.log(`Tidal: no manifest for track ${track.id} with ${audioQuality}`);
          continue;
        }

        let manifest: any = null;
        try {
          manifest = JSON.parse(Buffer.from(manifestB64, 'base64').toString('utf-8'));
        } catch {
          this.logger.warn('Tidal manifest was not valid JSON');
          continue;
        }

        // Check for DASH DRM (unplayable without decryption)
        if (manifest?.manifestMimeType === 'application/dash+xml') {
          this.logger.log(`Tidal: DASH DRM stream for track ${track.id} with ${audioQuality}, skipping`);
          continue;
        }

        const url: string | undefined = manifest?.urls?.[0];
        if (!url) {
          this.logger.log(`Tidal: no stream URL for track ${track.id} with ${audioQuality}`);
          continue;
        }

        const isEncrypted = manifest?.encryptionType && manifest.encryptionType !== 'NONE';
        if (isEncrypted) {
          this.logger.log(`Tidal: encrypted stream for track ${track.id} with ${audioQuality}`);
          continue;
        }

        let bitrate = 1411;
        let qualityLabel = 'FLAC 16-bit/44.1kHz (Lossless)';
        let isLossless = true;

        if (audioQuality === 'HI_RES') {
          bitrate = 2304;
          qualityLabel = 'FLAC 24-bit/96kHz (Hi-Res Lossless)';
        } else if (audioQuality === 'HIGH') {
          bitrate = 320;
          qualityLabel = 'AAC 320kbps (High Quality)';
          isLossless = false;
        }

        return {
          streamUrl: url,
          trackId: track.id,
          proxyUrl: url,
          bitrate,
          codec: isLossless ? 'FLAC' : 'AAC',
          mimeType: isLossless ? 'audio/flac' : 'audio/mp4; codecs="mp4a.40.2"',
          qualityLabel,
          quality: 'high',
          isLossless,
          source: `Tidal ${audioQuality}`,
          title: track.title,
          artists: track.artist,
          isEncrypted: false,
          fileSize: 0,
          duration: Number(track.duration) || 0,
          isrc: track.isrc,
        };
      } catch (err: any) {
        this.logger.warn(`Tidal playback failed for ${audioQuality}: ${err?.message || err}`);
        continue;
      }
    }

    this.logger.warn(`Tidal: all quality tiers failed for track ${track.id}`);
    return null;
  }
}
