import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { RateLimitGuard } from '../src/common/rate-limit/rate-limit.guard.js';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service.js';
import { RecipientAccessService } from '../src/secrets/recipient-access.service.js';
import { SecretsController } from '../src/secrets/secrets.controller.js';
import { SecretsService } from '../src/secrets/secrets.service.js';

describe('Paid-only secret creation (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let createAnonymous: ReturnType<typeof vi.fn>;
  let rateLimitConsume: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const rateLimitBuckets = new Map<string, number>();
    createAnonymous = vi
      .fn()
      .mockRejectedValue(
        new ForbiddenException(
          'Creating secrets requires an authenticated Pro or Team subscription',
        ),
      );
    rateLimitConsume = vi.fn(async (_policy: string, key: string) => {
      const attempts = rateLimitBuckets.get(key) ?? 0;
      if (attempts >= 3) {
        return { allowed: false, retryAfterSeconds: 3600 };
      }
      rateLimitBuckets.set(key, attempts + 1);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SecretsController],
      providers: [
        { provide: APP_GUARD, useClass: RateLimitGuard },
        {
          provide: RateLimitService,
          useValue: { consume: rateLimitConsume },
        },
        {
          provide: SecretsService,
          useValue: { createAnonymous },
        },
        {
          provide: RecipientAccessService,
          useValue: {},
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('rejects anonymous secret creation through the legacy endpoint', async () => {
    const response = await request(app!.getHttpServer())
      .post('/api/v1/secrets/anonymous')
      .set('User-Agent', 'anonymous-secrets-e2e')
      .send(validSecret());

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      message:
        'Creating secrets requires an authenticated Pro or Team subscription',
      error: 'Forbidden',
    });
    expect(createAnonymous).toHaveBeenCalledOnce();
  });

  it('rejects unauthenticated creation through the main endpoint', async () => {
    const response = await request(app!.getHttpServer())
      .post('/api/v1/secrets')
      .set('User-Agent', 'unauthenticated-secret-e2e')
      .send(validSecret());

    expect(response.status).toBe(403);
    expect(createAnonymous).toHaveBeenCalledOnce();
  });

  it('validates anonymous secret requests before reaching the service', async () => {
    const response = await request(app!.getHttpServer())
      .post('/api/v1/secrets')
      .set('User-Agent', 'anonymous-secrets-validation-e2e')
      .send({ ...validSecret(), max_views: 1.5 });

    expect(response.status).toBe(400);
    expect(createAnonymous).not.toHaveBeenCalled();
  });

  it('rate limits repeated rejected creation requests by client and device', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createRequest('anonymous-secrets-abuse-e2e')
        .send(validSecret())
        .expect(403);
    }

    const limitedResponse = await createRequest('anonymous-secrets-abuse-e2e')
      .send(validSecret())
      .expect(429)
      .expect('Retry-After', /\d+/);
    expect(limitedResponse.body).toEqual(
      expect.objectContaining({
        message: 'Too many requests; please try again later',
        retryAfterSeconds: expect.any(Number),
      }),
    );

    await createRequest('anonymous-secrets-other-device-e2e')
      .send(validSecret())
      .expect(403);
    expect(createAnonymous).toHaveBeenCalledTimes(4);
    expect(rateLimitConsume).toHaveBeenCalled();
  });

  function createRequest(userAgent: string) {
    return request(app!.getHttpServer())
      .post('/api/v1/secrets/anonymous')
      .set('User-Agent', userAgent);
  }
});

function validSecret() {
  return {
    ciphertext: 'Y2lwaGVydGV4dA',
    iv: 'aXZpdg',
    kdf: { algorithm: 'HKDF-SHA-256' },
    max_views: 3,
    expires_in: 60 * 60,
  };
}
