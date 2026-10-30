import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggerService } from '../services/logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly loggerService: LoggerService) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Determine status code
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal Server Error';
    let code: string | undefined;
    let attemptsLeft: number | undefined;
    let retryAfterSeconds: number | undefined;
    const prismaCode = getPrismaErrorCode(exception);

    this.loggerService.logHttpError(request, {
      status,
      name: exception.name,
      ...(prismaCode ? { prismaCode } : {}),
    });

    // Handle different types of exceptions
    let errors: any[] = [];
    if (exception instanceof HttpException) {
      // Only for HttpExceptions, we'll show the actual message
      // These are typically application-level errors that are safe to expose
      const errorResponse = exception.getResponse();
      if (typeof errorResponse === 'object' && errorResponse !== null) {
        if ('code' in errorResponse && typeof errorResponse.code === 'string') {
          code = errorResponse.code;
        }
        if (
          'attempts_left' in errorResponse &&
          typeof errorResponse.attempts_left === 'number'
        ) {
          attemptsLeft = errorResponse.attempts_left;
        }
        if (
          'retryAfterSeconds' in errorResponse &&
          typeof errorResponse.retryAfterSeconds === 'number'
        ) {
          retryAfterSeconds = errorResponse.retryAfterSeconds;
        }
      }

      if (status === HttpStatus.GONE) code ??= 'secret_unavailable';
      if (status === HttpStatus.NOT_FOUND) code ??= 'not_found';
      message =
        typeof errorResponse === 'object' && 'message' in errorResponse
          ? (errorResponse as any).message
          : errorResponse;
      
      // Extract errors array if present in the response
      if (typeof errorResponse === 'object' && errorResponse !== null && 'errors' in errorResponse) {
        errors = (errorResponse as any).errors || [];
      }
    }

    // Return sanitized response
    response.status(status).json({
      statusCode: status,
      ...(code ? { code } : {}),
      message: Array.isArray(message) ? message : [message],
      ...(attemptsLeft === undefined
        ? {}
        : { attempts_left: attemptsLeft }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      timestamp: new Date().toISOString(),
      path: request.url,
      errors: Array.isArray(errors) ? errors : [],
    });
  }
}

function getPrismaErrorCode(exception: unknown): string | undefined {
  if (
    !(exception instanceof Error) ||
    exception.name !== 'PrismaClientKnownRequestError' ||
    !('code' in exception) ||
    typeof exception.code !== 'string' ||
    !/^P\d{4}$/.test(exception.code)
  ) {
    return undefined;
  }

  return exception.code;
}
