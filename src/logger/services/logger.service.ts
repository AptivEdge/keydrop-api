import { ConsoleLogger, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { createCloudWatchTransport } from '../aws/cloudwatch-transport';

// Helper function to strip ANSI color codes
const stripAnsi = (str: string): string => {
  // This regex matches all ANSI color codes including complex ones like [38;5;3m, [95m, etc.
  return str.replace(/\u001b\[[0-9;]*m/g, '');
};

@Injectable()
export class LoggerService extends ConsoleLogger {
  private readonly winstonLogger: winston.Logger;
  private readonly useWinston: boolean;

  constructor(private configService: ConfigService) {
    super();

    // Determine if we should use Winston based on environment
    this.useWinston =
      this.configService.get<string>('NODE_ENV') !== 'development';

    // Initialize Winston logger only if needed
    if (this.useWinston) {
      // Define log format - clean and structured without colors
      const logFormat = winston.format.printf(
        ({ level, message, timestamp, ...meta }) => {
          // Strip ANSI color codes from all string values
          const cleanLevel =
            typeof level === 'string' ? stripAnsi(level) : level;
          const cleanMessage =
            typeof message === 'string' ? stripAnsi(message) : message;
          
          // Clean any ANSI codes from meta object recursively
          const cleanMeta = this.cleanObjectFromAnsi(meta);

          // Create clean, structured log entry
          return JSON.stringify({
            level: cleanLevel,
            timestamp,
            message: cleanMessage,
            ...cleanMeta,
          });
        },
      );

      // Create format with colors for console in development only
      const developmentFormat = winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize({ all: true }),
        winston.format.splat(),
        logFormat,
      );

      // Create format without colors for production and file logs
      const productionFormat = winston.format.combine(
        winston.format.timestamp(),
        winston.format.uncolorize(), // Explicitly remove colors
        winston.format.splat(),
        logFormat,
      );

      // Console transport (always use clean format, no colors in logs)
      const consoleTransport = new winston.transports.Console({
        level: 'debug',
        format: productionFormat, // Use clean format even in development
      });

      // File transport (without colors)
      const fileTransport = new winston.transports.DailyRotateFile({
        level: 'debug',
        dirname: 'logs',
        filename: 'application-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        format: productionFormat,
      });

      // Create logger with transports
      this.winstonLogger = winston.createLogger({
        level: 'debug',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.splat(),
        ),
        defaultMeta: { service: 'keydrop-api' },
        transports: [
          consoleTransport,
          ...(this.configService.get<string>('NODE_ENV') === 'production'
            ? []
            : [fileTransport]),
        ],
      });

      // Add CloudWatch transport in production
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        const cloudWatchTransport = createCloudWatchTransport({
          logGroupName: this.configService.get<string>(
            'AWS_CLOUDWATCH_LOG_GROUP',
            'keydrop-api',
          ),
          logStreamName: `${this.configService.get<string>('NODE_ENV')}-${new Date().toISOString().slice(0, 10)}`,
          awsRegion: this.configService.get<string>('AWS_REGION', 'us-east-1'),
          level: 'info',
        });

        this.winstonLogger.add(cloudWatchTransport);
      }

      this.log('Winston logger initialized for production', 'LoggerService');
    } else {
      this.log('Using NestJS default logger for development', 'LoggerService');
    }
  }

  // Helper method to recursively clean ANSI codes from objects
  private cleanObjectFromAnsi(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (typeof obj === 'string') {
      return stripAnsi(obj);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanObjectFromAnsi(item));
    }
    
    if (typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        cleaned[key] = this.cleanObjectFromAnsi(value);
      }
      return cleaned;
    }
    
    return obj;
  }

  log(message: any, context?: string) {
    if (this.useWinston) {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      this.winstonLogger.info(cleanMessage, { context });
    } else {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      super.log(cleanMessage, context);
    }
  }

  error(message: any, trace?: string, context?: string) {
    if (this.useWinston) {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      const cleanTrace = typeof trace === 'string' ? stripAnsi(trace) : trace;
      this.winstonLogger.error(cleanMessage, { trace: cleanTrace, context });
    } else {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      const cleanTrace = typeof trace === 'string' ? stripAnsi(trace) : trace;
      super.error(cleanMessage, cleanTrace, context);
    }
  }

  warn(message: any, context?: string) {
    if (this.useWinston) {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      this.winstonLogger.warn(cleanMessage, { context });
    } else {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      super.warn(cleanMessage, context);
    }
  }

  debug(message: any, context?: string) {
    if (this.useWinston) {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      this.winstonLogger.debug(cleanMessage, { context });
    } else {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      super.debug(cleanMessage, context);
    }
  }

  verbose(message: any, context?: string) {
    if (this.useWinston) {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      this.winstonLogger.verbose(cleanMessage, { context });
    } else {
      const cleanMessage = typeof message === 'string' ? stripAnsi(message) : message;
      super.verbose(cleanMessage, context);
    }
  }

  // Helper for logging HTTP requests
  logHttpRequest(req: any, context?: string): void {
    const shouldLogBody = true; // Enable body logging for all requests
    
    if (this.useWinston) {
      const logData: any = {
        context: context || 'HTTP',
        method: req.method,
        url: req.url,
        headers: {
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for'] || req.ip,
          authorization: req.headers['authorization'] ? 'present' : 'absent',
          'content-type': req.headers['content-type'],
          'content-length': req.headers['content-length'],
        },
        query: req.query,
        params: req.params,
      };

      // Handle different content types for body logging
      if (shouldLogBody) {
        const contentType = req.headers['content-type'] || '';
        
        if (contentType.includes('multipart/form-data')) {
          // For multipart/form-data, log file fields and other form fields
          const formData: any = {};
          
          if (req.body) {
            // Log non-file fields from body
            Object.keys(req.body).forEach(key => {
              if (req.body[key] && typeof req.body[key] !== 'object') {
                formData[key] = req.body[key];
              }
            });
          }
          
          if (req.files) {
            // Log file information without actual file content
            if (Array.isArray(req.files)) {
              formData.files = req.files.map((file: any) => ({
                fieldname: file.fieldname,
                originalname: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
              }));
            } else if (typeof req.files === 'object') {
              formData.files = {};
              Object.keys(req.files).forEach(fieldName => {
                const files = req.files[fieldName];
                if (Array.isArray(files)) {
                  formData.files[fieldName] = files.map((file: any) => ({
                    originalname: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                  }));
                } else {
                  formData.files[fieldName] = {
                    originalname: files.originalname,
                    mimetype: files.mimetype,
                    size: files.size,
                  };
                }
              });
            }
          }
          
          logData.formData = formData;
          logData.bodyKeys = Object.keys(formData);
        } else if (req.body && Object.keys(req.body).length > 0) {
          // For JSON and other content types
          logData.body = req.body;
          logData.bodyKeys = Object.keys(req.body);
        } else {
          logData.bodyKeys = [];
        }
      } else {
        logData.bodyKeys = req.body ? Object.keys(req.body) : [];
      }

      this.winstonLogger.info('Incoming request', this.cleanObjectFromAnsi(logData));
    } else {
      let logMessage = `Request: ${req.method} ${req.url} | Query: ${JSON.stringify(req.query)} | Params: ${JSON.stringify(req.params)}`;

      // Add body to log message
      if (shouldLogBody && req.body) {
        logMessage += ` | Body: ${JSON.stringify(req.body)}`;
      }

      if (req.files) {
        logMessage += ` | Files: ${JSON.stringify(req.files)}`;
      }

      super.log(logMessage, context || 'HTTP');
    }
  }

  // Helper for logging HTTP responses
  logHttpResponse(
    req: any,
    res: any,
    responseTime: number,
    context?: string,
  ): void {
    if (this.useWinston) {
      this.winstonLogger.info('Outgoing response', this.cleanObjectFromAnsi({
        context: context || 'HTTP',
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        responseTime: `${responseTime}ms`,
      }));
    } else {
      const logMessage = `Response: ${req.method} ${req.url} | Status: ${res.statusCode} | Time: ${responseTime}ms`;
      super.log(logMessage, context || 'HTTP');
    }
  }

  // Helper for logging HTTP errors
  logHttpError(req: any, error: any, context?: string): void {
    if (this.useWinston) {
      this.winstonLogger.error('HTTP Error', this.cleanObjectFromAnsi({
        context: context || 'HTTP',
        method: req.method,
        url: req.url,
        error: {
          message: error.message,
          stack: error.stack,
          status: error.status || 500,
        },
      }));
    } else {
      const status = error.status || 500;
      const logMessage = [
        `ERROR [${status}]: ${req.method} ${req.url}`,
        `Message: ${error.message}`,
        `Stack: ${error.stack}`,
      ].join('\n');

      super.error(logMessage, null, context || 'HTTP');
    }
  }
}
