import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_KEY,
  RateLimitPolicy,
} from './rate-limit.decorator.js';
import { RateLimitService } from './rate-limit.service.js';

interface RateLimitedRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { userId?: string };
}

interface RateLimitResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policy) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const key = this.getClientKey(request);
    const result = await this.rateLimit.consume(policy, key);
    if (!result.allowed) {
      context
        .switchToHttp()
        .getResponse<RateLimitResponse>()
        .setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        {
          code: 'rate_limited',
          message: 'Too many requests; please try again later',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private getClientKey(request: RateLimitedRequest): string {
    const userId = request.user?.userId;
    const ip = normalizeIp(request.ip);
    const device = this.headerValue(request.headers['user-agent']) ?? 'unknown';
    const deviceHash = createHash('sha256').update(device).digest('hex').slice(0, 16);
    return `${userId ?? 'anonymous'}:${ip}:${deviceHash}`;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}

function normalizeIp(value: string | undefined): string {
  return value?.trim() || 'unknown';
}
