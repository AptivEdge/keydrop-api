import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../services/logger.service';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly loggerService: LoggerService) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Skip logging for health check routes
    if (this.isHealthCheckRoute(req.originalUrl)) {
      return next();
    }

    // Log the request
    this.loggerService.logHttpRequest(req);

    // Record request start time
    const startTime = Date.now();

    // Get original end method
    const originalEnd = res.end;

    // Override res.end to capture and log response
    res.end = ((...args: any[]): Response => {
      // Calculate response time
      const responseTime = Date.now() - startTime;

      // Skip logging response for health check routes (extra safety check)
      if (!this.isHealthCheckRoute(req.originalUrl)) {
        // Log the response
        this.loggerService.logHttpResponse(req, res, responseTime);
      }

      // Execute original end
      return (originalEnd as (...args: any[]) => Response).apply(res, args);
    }) as Response['end'];

    next();
  }

  private isHealthCheckRoute(url: string): boolean {
    // Check for exact health check route or routes that start with health
    return (
      url === '/api/v1/health' ||
      url.startsWith('/api/v1/health/') ||
      url === '/health' ||
      url.startsWith('/health/')
    );
  }
}
