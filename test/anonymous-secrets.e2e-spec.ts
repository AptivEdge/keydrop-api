import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { RateLimitModule } from '../src/common/rate-limit/rate-limit.module.js';
import { RecipientAccessService } from '../src/secrets/recipient-access.service.js';
import { SecretsController } from '../src/secrets/secrets.controller.js';
import { SecretsService } from '../src/secrets/secrets.service.js';

describe('Anonymous secrets (e2e)', () => {
  let app: INestApplication<App>;
  let createAnonymous: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    createAnonymous = vi.fn().mockResolvedValue({
      id: 'anonymous-1',
      status: 'active',
      maxViews: 3,
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [RateLimitModule],
      controllers: [SecretsController],
      providers: [
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
    await app.close();
  });

  it('creates an anonymous secret through the public HTTP endpoint', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/secrets/anonymous')
      .set('User-Agent', 'anonymous-secrets-e2e')
      .send(validAnonymousSecret());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 'anonymous-1',
      status: 'active',
      maxViews: 3,
    });
    expect(createAnonymous).toHaveBeenCalledWith(
      expect.objectContaining({
        ciphertextRef: 'ciphertext',
        maxViews: 3,
      }),
    );
  });

  it('validates anonymous secret requests before reaching the service', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/secrets/anonymous')
      .set('User-Agent', 'anonymous-secrets-validation-e2e')
      .send({ ...validAnonymousSecret(), maxViews: 1.5 });

    expect(response.status).toBe(400);
    expect(createAnonymous).not.toHaveBeenCalled();
  });

  it('limits repeated anonymous secret creation requests by client and device', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createRequest('anonymous-secrets-abuse-e2e')
        .send(validAnonymousSecret())
        .expect(201);
    }

    const limitedResponse = await createRequest('anonymous-secrets-abuse-e2e')
      .send(validAnonymousSecret())
      .expect(429)
      .expect('Retry-After', /\d+/);
    expect(limitedResponse.body).toEqual(
      expect.objectContaining({
        message: 'Too many requests; please try again later',
        retryAfterSeconds: expect.any(Number),
      }),
    );

    await createRequest('anonymous-secrets-other-device-e2e')
      .send(validAnonymousSecret())
      .expect(201);
    expect(createAnonymous).toHaveBeenCalledTimes(4);
  });

  function createRequest(userAgent: string) {
    return request(app.getHttpServer())
      .post('/api/v1/secrets/anonymous')
      .set('User-Agent', userAgent);
  }
});

function validAnonymousSecret() {
  return {
    ciphertextRef: 'ciphertext',
    iv: 'iv',
    wrappedKey: 'wrapped-key',
    salt: 'salt',
    maxViews: 3,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}
