import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, type Request, type Response } from 'express';
import { AppModule } from './app.module.js';
import { LoggerService } from './logger/services/logger.service.js';
import path from 'node:path';
import fs from 'node:fs';

export async function createApplication(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    bodyParser: false,
  });
  app.use(json({ limit: 400_000, verify: captureRawBody }));
  app.use(urlencoded({ extended: true, limit: 400_000 }));
  const config = app.get(ConfigService);
  const logger = app.get(LoggerService);
  validateRuntimeConfiguration(config);

  app.useLogger(logger);
  app.setGlobalPrefix('/api/v1');
  app.enableCors({
    origin: getCorsOrigins(
      config.get<string>('FRONTEND_URL'),
      config.get<string>('NODE_ENV'),
    ),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  setupSwagger(app, config);

  await app.init();
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get(ConfigService);
  const logger = app.get(LoggerService);
  const port = config.get<number>('PORT', 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Keydrop API listening on port ${port}`, 'Bootstrap');
}

function captureRawBody(
  request: Request,
  _response: Response,
  buffer: Buffer,
): void {
  (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
}

function setupSwagger(
  app: Parameters<typeof SwaggerModule.createDocument>[0],
  config: ConfigService,
): void {
  const enabled =
    config.get<string>('SWAGGER_ENABLED') !== 'false' &&
    config.get<string>('NODE_ENV') !== 'production';

  if (!enabled) {
    return;
  }

  const documentConfig = new DocumentBuilder()
    .setTitle('Keydrop API')
    .setDescription(
      'Secure one-time secret sharing, account, team, and staff APIs.',
    )
    .setVersion('1.0')
    .addTag('Health', 'Public health and service checks')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase Auth JWT for protected API routes.',
      },
      'supabase',
    )
    .addTag('Users', 'Customer account management')
    .addTag('Authentication', 'Supabase Auth and email verification')
    .addTag('Secrets', 'One-time secret operations')
    .addTag('Teams', 'Team membership and policy operations')
    .addTag('Billing', 'Plan, subscription, and invoice operations')
    .addTag('Admin', 'Staff-only operations')
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);

  exportSwaggerFile(document, 'swagger.json');

  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}

function getCorsOrigins(
  frontendUrl?: string,
  nodeEnv?: string,
): string[] | boolean {
  if (!frontendUrl) {
    if (nodeEnv === 'production') {
      throw new Error('FRONTEND_URL must be configured in production');
    }
    return true;
  }

  return frontendUrl
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function validateRuntimeConfiguration(config: ConfigService): void {
  if (config.get<string>('NODE_ENV') !== 'production') return;
  const required = [
    'DATABASE_URL',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'RAZORPAY_PRO_MONTHLY_PLAN_ID',
    'RAZORPAY_PRO_YEARLY_PLAN_ID',
    'RAZORPAY_TEAM_MONTHLY_PLAN_ID',
    'RAZORPAY_TEAM_YEARLY_PLAN_ID',
    'RECIPIENT_ACCESS_TOKEN_SECRET',
    'SECRET_AUTH_PEPPER',
    'FRONTEND_URL',
  ];
  if (process.env.VERCEL === '1') {
    required.push('INTERNAL_JOBS_TOKEN');
  }
  const authProvider =
    config.get<string>('AUTH_PROVIDER')?.toLowerCase() ?? 'supabase';
  const authRequired =
    authProvider === 'supabase'
      ? ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
      : ['AUTH_PROVIDER (must be supabase)'];
  const emailProvider =
    config.get<string>('EMAIL_PROVIDER')?.toLowerCase() ?? 'resend';
  const emailRequired =
    emailProvider === 'resend'
      ? ['EMAIL_API_KEY', 'EMAIL_FROM']
      : ['EMAIL_PROVIDER (must be resend)'];
  const storageProvider =
    config.get<string>('STORAGE_PROVIDER')?.toLowerCase() ?? 'r2';
  const storageRequired =
    storageProvider === 'r2'
      ? ['R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
      : ['STORAGE_PROVIDER (must be r2)'];
  if (storageProvider === 'r2' && !config.get<string>('R2_ENDPOINT')) {
    storageRequired.push('R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  const missing = [
    ...required,
    ...authRequired,
    ...emailRequired,
    ...storageRequired,
  ].filter((key) => {
    if (key === 'R2_ENDPOINT or R2_ACCOUNT_ID') {
      return (
        !config.get<string>('R2_ENDPOINT') &&
        !config.get<string>('R2_ACCOUNT_ID')
      );
    }
    if (key === 'STORAGE_PROVIDER (must be r2)') return true;
    return !config.get<string>(key);
  });
  if (missing.length) {
    throw new Error(
      `Missing required production configuration: ${missing.join(', ')}`,
    );
  }
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const logger = new Logger('Bootstrap');
    logger.error(
      'Failed to start Keydrop API',
      error instanceof Error ? error.stack : String(error),
    );
    process.exitCode = 1;
  });
}

/**
 * Generates and saves a static Swagger JSON file from a NestJS OpenAPI document object.
 * @param document The OpenAPIObject created by SwaggerModule.createDocument
 * @param filename Optional custom filename (defaults to 'swagger.json')
 */
export function exportSwaggerFile(
  document: OpenAPIObject,
  filename = 'swagger.json',
): void {
  try {
    if (!document || typeof document !== 'object') {
      throw new Error('Invalid OpenAPI document provided.');
    }

    if (!filename || typeof filename !== 'string') {
      throw new Error('Invalid filename provided.');
    }

    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[Swagger] Exporting Swagger file in production is not recommended.',
      );
      return;
    }
    const outputPath = path.resolve(process.cwd(), filename);

    // Convert the document object to a pretty-printed JSON string
    const jsonString = JSON.stringify(document, null, 2);

    fs.writeFileSync(outputPath, jsonString, 'utf8');
    console.log(`[Swagger] File successfully exported to: ${outputPath}`);
  } catch (error) {
    console.error('[Swagger] Failed to export schema file:', error);
  }
}
