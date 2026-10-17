import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LoggerService } from '../services/logger.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private loggerService: LoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;
    const url = request.url;
    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          const response = context.switchToHttp().getResponse();
          const statusCode = response.statusCode;
          const responseTime = Date.now() - now;

          // For successful responses
          this.loggerService.debug(
            `Response success - ${method} ${url} ${statusCode} - ${responseTime}ms`,
            'ResponseInterceptor',
          );
        },
        error: (error) => {
          const responseTime = Date.now() - now;

          // For errors
          this.loggerService.error(
            `Response error - ${method} ${url} - ${responseTime}ms`,
            error.stack,
            'ResponseInterceptor',
          );
        },
      }),
    );
  }
}
