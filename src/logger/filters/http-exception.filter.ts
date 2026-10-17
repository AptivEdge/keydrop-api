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

    // Log the complete error details for debugging
    this.loggerService.logHttpError(request, {
      message: exception.message,
      stack: exception.stack,
      status,
      name: exception.name,
      code: exception.code,
      meta: exception.meta,
      clientVersion: exception.clientVersion,
      // Any other properties that might be helpful for debugging
    });

    // Handle different types of exceptions
    let errors: any[] = [];
    if (exception instanceof HttpException) {
      // Only for HttpExceptions, we'll show the actual message
      // These are typically application-level errors that are safe to expose
      const errorResponse = exception.getResponse();
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
      message: Array.isArray(message) ? message : [message],
      timestamp: new Date().toISOString(),
      path: request.url,
      errors: Array.isArray(errors) ? errors : [],
    });
  }
}
