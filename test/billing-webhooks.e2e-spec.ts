import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BillingService } from '../src/billing/billing.service.js';
import { BillingWebhookController } from '../src/billing/billing-webhook.controller.js';

describe('Billing Razorpay webhook (e2e)', () => {
  let app: INestApplication<App>;
  const webhookSecret = 'test-webhook-secret';
  let capturedRawBody: Buffer | undefined;
  const prisma = {
    $transaction: vi.fn(),
    billingWebhookEvent: {
      create: vi.fn().mockResolvedValue({ id: 'event-row' }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    billingRefund: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'RAZORPAY_WEBHOOK_SECRET' ? webhookSecret : undefined,
    ),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedRawBody = undefined;
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof prisma) => Promise<void>) =>
        callback(prisma),
    );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [BillingWebhookController],
      providers: [
        BillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    app.use(
      express.json({
        verify: (request, _response, rawBody) => {
          capturedRawBody = Buffer.from(rawBody);
          (request as Request & { rawBody?: Buffer }).rawBody = capturedRawBody;
        },
      }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    'subscription-activated',
    'invoice-paid',
    'payment-failed',
    'refund-processed',
  ])('accepts a correctly signed %s fixture over HTTP', async (fixture) => {
    const rawBody = readFileSync(
      join(process.cwd(), 'test', 'fixtures', 'razorpay', `${fixture}.json`),
    );
    const signature = createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', `event-${fixture}`)
      .send(rawBody.toString('utf8'));
    expect(capturedRawBody).toEqual(rawBody);
    expect(response.status, response.text).toBe(201);
    expect(response.body).toEqual({ accepted: true });

    expect(prisma.billingWebhookEvent.create).toHaveBeenCalledWith({
      data: {
        provider: 'razorpay',
        eventId: `event-${fixture}`,
        eventType: expect.any(String),
      },
    });
    expect(prisma.billingWebhookEvent.update).toHaveBeenCalled();
  });
});
