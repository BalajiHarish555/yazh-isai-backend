import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      // Must match the signing secret in AuthModule's JwtModule.register
      // (process.env.JWT_SECRET || 'secret') — a different fallback here
      // silently rejected every authenticated request when JWT_SECRET is unset.
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET || 'secret',
      });
      (request as any).user = payload;
      (request as any).user.userId = payload.sub || payload.id;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}