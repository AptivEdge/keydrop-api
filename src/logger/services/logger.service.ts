import { ConsoleLogger, Injectable } from '@nestjs/common';

const sensitiveAssignmentPattern =
  /\b(password|token|secret|authorization|api[-_]?key|client[-_]?secret|signature|otp|verification[-_]?code)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function sanitizeText(value: unknown): string {
  return String(value)
    .replace(sensitiveAssignmentPattern, '$1$2[REDACTED]')
    .replace(bearerTokenPattern, 'Bearer [REDACTED]');
}

function requestPath(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

@Injectable()
export class LoggerService extends ConsoleLogger {
  logHttpRequest(req: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    files?: unknown[] | Record<string, unknown>;
  }, context = 'HTTP'): void {
    const bodyKeys =
      req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    const fileCount = Array.isArray(req.files)
      ? req.files.length
      : req.files && typeof req.files === 'object'
        ? Object.keys(req.files).length
        : 0;
    this.log(
      JSON.stringify({
        event: 'incoming_request',
        method: req.method,
        path: requestPath(req.url),
        contentType: req.headers?.['content-type'],
        contentLength: req.headers?.['content-length'],
        queryKeys: Object.keys(req.query ?? {}),
        paramKeys: Object.keys(req.params ?? {}),
        bodyKeys,
        fileCount,
      }),
      context,
    );
  }

  logHttpResponse(
    req: { method?: string; url?: string },
    res: { statusCode?: number },
    responseTime: number,
    context = 'HTTP',
  ): void {
    this.log(
      JSON.stringify({
        event: 'outgoing_response',
        method: req.method,
        path: requestPath(req.url),
        statusCode: res.statusCode,
        responseTimeMs: responseTime,
      }),
      context,
    );
  }

  logHttpError(
    req: { method?: string; url?: string },
    error: {
      status?: number;
      name?: string;
      prismaCode?: string;
    },
    context = 'HTTP',
  ): void {
    this.error(
      JSON.stringify({
        event: 'http_error',
        method: req.method,
        path: requestPath(req.url),
        statusCode: error.status ?? 500,
        errorType: error.name ?? 'Error',
        ...(error.prismaCode ? { prismaCode: error.prismaCode } : {}),
      }),
      undefined,
      context,
    );
  }

  override log(message: any, context?: string): void {
    super.log(sanitizeText(message), context);
  }

  override warn(message: any, context?: string): void {
    super.warn(sanitizeText(message), context);
  }

  override error(message: any, stack?: string, context?: string): void {
    super.error(
      sanitizeText(message),
      stack ? sanitizeText(stack) : undefined,
      context,
    );
  }

  override debug(message: any, context?: string): void {
    super.debug(sanitizeText(message), context);
  }

  override verbose(message: any, context?: string): void {
    super.verbose(sanitizeText(message), context);
  }
}
