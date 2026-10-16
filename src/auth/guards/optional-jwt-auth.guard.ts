import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Personalization when a token is present, anonymous feed when it is not.
 * Extends the strict guard: any failure (missing/invalid/expired token)
 * simply leaves `req.user` unset instead of rejecting the request —
 * endpoints using this guard must treat `req.user` as optional.
 */
@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch {
      return true;
    }
  }
}
