import { Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TidalService } from './tidal.service';

@Controller('tidal')
export class TidalController {
  constructor(private readonly tidalService: TidalService) {}

  @Get('status')
  async status() {
    return this.tidalService.status();
  }

  /**
   * Start a device-code login. Returns the URL to open in a browser
   * (link.tidal.com/{code}) and a userCode to approve.
   */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('login')
  async login() {
    try {
      return await this.tidalService.startLogin();
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Poll for login approval. Call repeatedly (every ~5s) until
   * loggedIn: true is returned.
   */
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('poll')
  async poll() {
    try {
      return await this.tidalService.pollLogin();
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  @Post('logout')
  async logout() {
    this.tidalService.logout();
    return { ok: true };
  }
}
