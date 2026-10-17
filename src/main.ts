import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { LoggerService } from './logger/services/logger.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const logger = app.get(LoggerService);
  validateRuntimeConfiguration(config);

  app.useLogger(logger);
  app.setGlobalPrefix('api/v1');
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

  const port = config.get<number>('PORT', 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Keydrop API listening on port ${port}`, 'Bootstrap');
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
        description: 'Cognito ID token for protected API routes.',
      },
      'cognito',
    )
    .addTag('Users', 'Customer account management')
    .addTag('Authentication', 'Cognito and email verification')
    .addTag('Secrets', 'One-time secret operations')
    .addTag('Teams', 'Team membership and policy operations')
    .addTag('Billing', 'Plan, subscription, and invoice operations')
    .addTag('Admin', 'Staff-only operations')
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);
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
    'COGNITO_REGION',
    'USER_COGNITO_USER_POOL_ID',
    'USER_COGNITO_CLIENT_ID',
    'ADMIN_COGNITO_USER_POOL_ID',
    'ADMIN_COGNITO_CLIENT_ID',
    'SES_REGION',
    'SES_FROM_EMAIL',
    'S3_REGION',
    'S3_BUCKET',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'RAZORPAY_PRO_MONTHLY_PLAN_ID',
    'RAZORPAY_PRO_YEARLY_PLAN_ID',
    'RAZORPAY_TEAM_MONTHLY_PLAN_ID',
    'RAZORPAY_TEAM_YEARLY_PLAN_ID',
    'RECIPIENT_ACCESS_TOKEN_SECRET',
    'FRONTEND_URL',
  ];
  const missing = required.filter((key) => !config.get<string>(key));
  if (missing.length) {
    throw new Error(
      `Missing required production configuration: ${missing.join(', ')}`,
    );
  }
}

void bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    'Failed to start Keydrop API',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
