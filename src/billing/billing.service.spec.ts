import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BillingService } from './billing.service.js';

describe('BillingService', () => {
  function createService(overrides: Record<string, unknown> = {}) {
    const prisma = {
      subscription: {
        findFirst: vi.fn().mockResolvedValue({ id: 'local-subscription' }),
      },
      ...overrides,
    };
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'RAZORPAY_KEY_SECRET') return 'checkout-secret';
        if (key === 'RAZORPAY_WEBHOOK_SECRET') return 'webhook-secret';
        if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_key';
        if (key === 'RAZORPAY_PRO_MONTHLY_PLAN_ID')
          return 'plan-pro-monthly-inr';
        if (key === 'RAZORPAY_TEAM_YEARLY_PLAN_ID') return 'plan-team-yearly';
        return undefined;
      }),
    };
    return {
      service: new BillingService(prisma as never, config as never),
      prisma,
    };
  }

  it('rejects checkout verification with an invalid signature', async () => {
    const { service } = createService();

    expect(() =>
      service.verifyCheckoutSignature('user-1', 'sub-1', 'pay-1', 'invalid'),
    ).toThrow(BadRequestException);
  });

  it('verifies a checkout signature without activating the plan', async () => {
    const { service, prisma } = createService();
    const signature = createHmac('sha256', 'checkout-secret')
      .update('pay-1|sub-1')
      .digest('hex');

    await expect(
      service.verifyCheckoutSignature('user-1', 'sub-1', 'pay-1', signature),
    ).resolves.toEqual({ verified: true, webhookRequired: true });
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { planId: 'sub-1', userId: 'user-1' },
      select: { id: true },
    });
  });

  it('fails explicitly when Razorpay is not configured', async () => {
    const prisma = {};
    const config = { get: vi.fn().mockReturnValue(undefined) };
    const service = new BillingService(prisma as never, config as never);

    await expect(
      service.createCheckout('user-1', 'pro', 'monthly'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('creates an INR checkout and stores INR currency', async () => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'u@test.com' }) },
      subscription: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const { service } = createService(prisma);
    const providerCreate = vi.fn().mockResolvedValue({ id: 'sub-inr-1' });
    Object.defineProperty(service, 'razorpay', {
      value: { subscriptions: { create: providerCreate } },
    });

    await expect(
      service.createCheckout('user-1', 'pro', 'monthly'),
    ).resolves.toEqual({
      provider: 'razorpay',
      keyId: 'rzp_test_key',
      subscriptionId: 'sub-inr-1',
      plan: 'pro',
      interval: 'monthly',
      currency: 'INR',
      email: 'u@test.com',
    });
    expect(providerCreate).toHaveBeenCalledWith({
      plan_id: 'plan-pro-monthly-inr',
      total_count: 120,
      customer_notify: 1,
      notes: {
        userId: 'user-1',
        plan: 'pro',
        interval: 'monthly',
        currency: 'INR',
      },
    });
    expect(prisma.subscription.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        planId: 'sub-inr-1',
        providerPlanId: 'plan-pro-monthly-inr',
        tier: 'pro',
        billingInterval: 'monthly',
        currency: 'INR',
        status: 'incomplete',
      },
    });
  });

  it('rejects refunds without a written reason', async () => {
    const { service } = createService();
    Object.defineProperty(service, 'razorpay', {
      value: { payments: { refund: vi.fn() } },
    });

    await expect(
      service.refundPayment('staff-1', 'pay-1', undefined, ''),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('records a billing audit event after a successful refund', async () => {
    const refund = {
      id: 'refund-1',
      payment_id: 'payment-1',
      status: 'processed',
      amount: 500,
      currency: 'INR',
    };
    const { service, prisma } = createService({
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    });
    const providerRefund = vi.fn().mockResolvedValue(refund);
    Object.defineProperty(service, 'razorpay', {
      value: { payments: { refund: providerRefund } },
    });

    await expect(
      service.refundPayment('staff-1', 'payment-1', 500, 'Customer request'),
    ).resolves.toEqual({
      id: 'refund-1',
      paymentId: 'payment-1',
      status: 'processed',
      amount: 500,
      currency: 'INR',
    });
    expect(providerRefund).toHaveBeenCalledWith('payment-1', {
      amount: 500,
      notes: { reason: 'Customer request', initiatedBy: 'staff-1' },
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: 'billing_refunded',
        actorId: 'staff-1',
        device: 'razorpay:refund-1',
      },
    });
  });

  it('rejects webhook payloads with an invalid signature', async () => {
    const config = {
      get: vi.fn((key: string) =>
        key === 'RAZORPAY_WEBHOOK_SECRET' ? 'webhook-secret' : undefined,
      ),
    };
    const service = new BillingService({} as never, config as never);

    await expect(
      service.processWebhook(
        Buffer.from('{"event":"subscription.activated"}'),
        'invalid',
        'event-1',
        {
          account_id: 'account-1',
          created_at: 1,
          event: 'subscription.activated',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records and processes a webhook event atomically', async () => {
    const prisma = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({ id: 'event-row-1' }),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      subscription: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: never) => Promise<void>) =>
        callback(prisma as never),
    );
    const config = {
      get: vi.fn((key: string) =>
        key === 'RAZORPAY_WEBHOOK_SECRET' ? 'webhook-secret' : undefined,
      ),
    };
    const service = new BillingService(prisma as never, config as never);
    const payload = {
      account_id: 'account-1',
      created_at: 1,
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: 'sub-1' } } },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await expect(
      service.processWebhook(rawBody, signature, ' razorpay-event-1 ', payload),
    ).resolves.toEqual({ accepted: true });
    expect(prisma.billingWebhookEvent.create).toHaveBeenCalledWith({
      data: {
        provider: 'razorpay',
        eventId: 'razorpay-event-1',
        eventType: 'subscription.activated',
      },
    });
    expect(prisma.billingWebhookEvent.update).toHaveBeenCalledWith({
      where: {
        provider_eventId: {
          provider: 'razorpay',
          eventId: 'razorpay-event-1',
        },
      },
      data: { processedAt: expect.any(Date) },
    });
  });

  it('returns duplicate when the unique event key already exists', async () => {
    const prisma = {
      billingWebhookEvent: {
        create: vi.fn().mockRejectedValue({ code: 'P2002' }),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ processedAt: new Date() }),
      },
      subscription: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: never) => Promise<void>) =>
        callback(prisma as never),
    );
    const config = {
      get: vi.fn((key: string) =>
        key === 'RAZORPAY_WEBHOOK_SECRET' ? 'webhook-secret' : undefined,
      ),
    };
    const service = new BillingService(prisma as never, config as never);
    const duplicatePayload = {
      account_id: 'account-1',
      created_at: 1,
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: 'sub-1' } } },
    };
    const rawBody = Buffer.from(JSON.stringify(duplicatePayload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await expect(
      service.processWebhook(rawBody, signature, 'event-1', duplicatePayload),
    ).resolves.toEqual({ accepted: true, duplicate: true });
    expect(prisma.billingWebhookEvent.update).not.toHaveBeenCalled();
  });

  it('rejects webhooks without a provider event ID', async () => {
    const config = {
      get: vi.fn((key: string) =>
        key === 'RAZORPAY_WEBHOOK_SECRET' ? 'webhook-secret' : undefined,
      ),
    };
    const service = new BillingService({} as never, config as never);
    const rawBody = Buffer.from('{"event":"subscription.activated"}');
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await expect(
      service.processWebhook(rawBody, signature, undefined, {
        account_id: 'account-1',
        created_at: 1,
        event: 'subscription.activated',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malformed payloads for known billing webhook events', async () => {
    const prisma = { billingWebhookEvent: { create: vi.fn() } };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1,
      event: 'invoice.paid',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await expect(
      service.processWebhook(rawBody, signature, 'malformed-event', payload),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('synchronizes a paid Razorpay invoice idempotently', async () => {
    const tx = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'local-subscription',
          userId: 'user-1',
          lastProviderEventAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
      billingWebhookEvent: { findUnique: vi.fn() },
      ...tx,
    };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1_797_000_000,
      event: 'invoice.paid',
      payload: {
        invoice: {
          entity: {
            id: 'inv-1',
            subscription_id: 'sub-1',
            payment_id: 'pay-1',
            amount: 1500,
            currency: 'INR',
            status: 'paid',
            issued_at: 1_796_000_000,
            paid_at: 1_797_000_000,
          },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await service.processWebhook(
      rawBody,
      signature,
      'invoice-event-1',
      payload,
    );

    expect(tx.invoice.upsert).toHaveBeenCalledWith({
      where: { externalId: 'inv-1' },
      create: expect.objectContaining({
        externalId: 'inv-1',
        paymentId: 'pay-1',
        subscriptionId: 'local-subscription',
        userId: 'user-1',
        amount: 1500,
        currency: 'INR',
        status: 'paid',
        paidAt: new Date(1_797_000_000 * 1000),
      }),
      update: expect.objectContaining({
        paymentId: 'pay-1',
        status: 'paid',
      }),
    });
  });

  it('marks failed payments past due and queues deduplicated notifications', async () => {
    const tx = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'local-subscription',
          userId: 'user-1',
          pastDueSince: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          notificationPreferences: {
            billing_payment_failed: { inApp: true, email: true },
          },
        }),
      },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
      billingWebhookEvent: { findUnique: vi.fn() },
      ...tx,
    };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1_797_000_000,
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay-failed-1',
            invoice_id: 'inv-failed-1',
            subscription_id: 'sub-1',
            amount: 1500,
            currency: 'INR',
          },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await service.processWebhook(
      rawBody,
      signature,
      'payment-event-1',
      payload,
    );

    expect(tx.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'local-subscription' },
        data: expect.objectContaining({
          status: 'past_due',
          pastDueSince: expect.any(Date),
        }),
      }),
    );
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'user-1',
          type: 'billing_payment_failed',
          dedupeKey: 'billing_payment_failed:pay-failed-1',
          emailSentAt: null,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('synchronizes refund state from signed Razorpay webhook events', async () => {
    const tx = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: {
        findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      billingRefund: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
      billingWebhookEvent: { findUnique: vi.fn() },
      ...tx,
    };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1_797_000_000,
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd-1',
            payment_id: 'pay-1',
            amount: 1500,
            currency: 'INR',
            status: 'processed',
          },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await service.processWebhook(rawBody, signature, 'refund-event-1', payload);

    expect(tx.billingRefund.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalId: 'rfnd-1' },
        create: expect.objectContaining({
          externalId: 'rfnd-1',
          paymentId: 'pay-1',
          userId: 'user-1',
          amount: 1500,
          currency: 'INR',
          status: 'processed',
        }),
        update: expect.objectContaining({
          amount: 1500,
          currency: 'INR',
          status: 'processed',
        }),
      }),
    );
  });

  it('stores a refund before its invoice arrives for later reconciliation', async () => {
    const tx = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: { findUnique: vi.fn().mockResolvedValue(null) },
      billingRefund: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
      billingWebhookEvent: { findUnique: vi.fn() },
      ...tx,
    };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1_797_000_000,
      event: 'refund.created',
      payload: {
        refund: {
          entity: {
            id: 'rfnd-early-1',
            payment_id: 'pay-early-1',
            amount: 500,
            currency: 'INR',
            status: 'pending',
          },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await service.processWebhook(
      rawBody,
      signature,
      'refund-early-event',
      payload,
    );

    expect(tx.billingRefund.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalId: 'rfnd-early-1' },
        create: expect.objectContaining({
          externalId: 'rfnd-early-1',
          paymentId: 'pay-early-1',
          userId: undefined,
        }),
      }),
    );
  });

  it('schedules plan changes at the cycle end through Razorpay', async () => {
    const prisma = {
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'local-subscription',
          planId: 'sub-provider-1',
          status: 'active',
          providerPlanId: 'plan-pro-monthly',
          tier: 'pro',
          billingInterval: 'monthly',
          currency: 'INR',
          pendingProviderPlanId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const { service } = createService(prisma);
    const updateProvider = vi.fn().mockResolvedValue({});
    Object.defineProperty(service, 'razorpay', {
      value: { subscriptions: { update: updateProvider } },
    });

    await service.changeSubscriptionPlan(
      'user-1',
      'local-subscription',
      'team',
      'yearly',
    );

    expect(updateProvider).toHaveBeenCalledWith('sub-provider-1', {
      plan_id: 'plan-team-yearly',
      schedule_change_at: 'cycle_end',
      customer_notify: 1,
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          pendingTier: 'team',
          pendingInterval: 'yearly',
          pendingProviderPlanId: 'plan-team-yearly',
        },
      }),
    );
  });

  it('rejects plan changes for non-INR subscriptions', async () => {
    const prisma = {
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'local-subscription',
          planId: 'sub-provider-1',
          status: 'active',
          providerPlanId: 'plan-pro-monthly',
          tier: 'pro',
          billingInterval: 'monthly',
          currency: 'USD',
          pendingProviderPlanId: null,
        }),
      },
    };
    const { service } = createService(prisma);
    const updateProvider = vi.fn().mockResolvedValue({});
    Object.defineProperty(service, 'razorpay', {
      value: { subscriptions: { update: updateProvider } },
    });

    await expect(
      service.changeSubscriptionPlan(
        'user-1',
        'local-subscription',
        'team',
        'yearly',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('applies a scheduled plan only after the provider charges the new plan', async () => {
    const tx = {
      billingWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'local-subscription',
          userId: 'user-1',
          pastDueSince: null,
          pendingTier: 'team',
          pendingInterval: 'yearly',
          pendingProviderPlanId: 'plan-team-yearly',
          lastProviderEventAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([{ tier: 'team' }]),
      },
      user: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
      billingWebhookEvent: { findUnique: vi.fn() },
      ...tx,
    };
    const { service } = createService(prisma);
    const payload = {
      account_id: 'account-1',
      created_at: 1_797_000_000,
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: 'sub-1',
            plan_id: 'plan-team-yearly',
            current_start: 1_797_000_000,
            current_end: 1_828_536_000,
          },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'webhook-secret')
      .update(rawBody)
      .digest('hex');

    await service.processWebhook(
      rawBody,
      signature,
      'charged-event-1',
      payload,
    );

    expect(tx.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tier: 'team',
          billingInterval: 'yearly',
          pendingTier: null,
          pendingInterval: null,
          pendingProviderPlanId: null,
        }),
      }),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { plan: 'team' },
    });
  });

  it('downgrades after seven days past due and revokes active API keys', async () => {
    const tx = {
      subscription: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: { update: vi.fn().mockResolvedValue({}) },
      apiKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      subscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'local-subscription',
            planId: 'sub-provider-1',
            userId: 'user-1',
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          status: 'past_due',
          pastDueSince: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        }),
      },
      $transaction: vi.fn((callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
      ),
    };
    const { service } = createService(prisma);
    const cancel = vi.fn().mockResolvedValue({});
    const fetch = vi.fn().mockResolvedValue({ status: 'halted' });
    Object.defineProperty(service, 'razorpay', {
      value: { subscriptions: { cancel, fetch } },
    });

    await service.reconcilePastDueSubscriptions();

    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'past_due',
          pastDueSince: { lte: expect.any(Date) },
        },
      }),
    );
    expect(cancel).toHaveBeenCalledWith('sub-provider-1', false);
    expect(fetch).toHaveBeenCalledWith('sub-provider-1');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { plan: 'free' },
    });
    expect(tx.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
