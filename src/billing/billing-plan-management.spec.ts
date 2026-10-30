import { BillingService } from './billing.service.js';
import { ConflictException } from '@nestjs/common';

describe('BillingService admin plan management', () => {
  function createService() {
    const prisma = {
      billingPlan: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({
          id: 'billing-plan-1',
          tier: 'pro',
          interval: 'monthly',
          providerPlanId: 'plan-created',
          name: 'Pro Monthly',
          amount: 12_345,
          currency: 'INR',
          active: true,
        }),
      },
      adminAuditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      subscription: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ email: 'admin@example.test' }),
      },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: never) => Promise<unknown>) =>
        callback(prisma as never),
    );
    const config = {
      get: vi.fn((key: string) => key === 'RAZORPAY_KEY_ID' ? 'rzp_test_key' : 'secret'),
    };
    const service = new BillingService(prisma as never, config as never);
    return { prisma, service };
  }

  it('creates a Razorpay plan, activates it, and records the staff audit event', async () => {
    const { prisma, service } = createService();
    const createProviderPlan = vi.fn().mockResolvedValue({
      id: 'plan-created',
      period: 'monthly',
      interval: 1,
      item: { amount: 12_345, currency: 'INR' },
    });
    Object.defineProperty(service, 'razorpay', {
      value: {
        plans: { create: createProviderPlan },
      },
    });

    await service.createAdminBillingPlan(
      {
        tier: 'pro',
        interval: 'monthly',
        name: ' Pro Monthly ',
        amount: 12_345,
        description: 'Updated Pro price',
        reason: 'Pricing updated after product review',
      },
      { userId: 'admin-1' } as never,
    );

    expect(createProviderPlan).toHaveBeenCalledWith(expect.objectContaining({
      period: 'monthly',
      interval: 1,
      item: expect.objectContaining({ name: 'Pro Monthly', amount: 12_345, currency: 'INR' }),
    }));
    expect(prisma.billingPlan.updateMany).toHaveBeenCalledWith({
      where: { tier: 'pro', interval: 'monthly', active: true },
      data: { active: false },
    });
    expect(prisma.billingPlan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tier: 'pro',
        interval: 'monthly',
        providerPlanId: 'plan-created',
        amount: 12_345,
        createdById: 'admin-1',
      }),
    }));
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'billing_plan_created',
        targetType: 'billing_plan',
        reason: 'Pricing updated after product review',
      }),
    }));
  });

  it('uses the active stored Razorpay plan and exact stored price for checkout', async () => {
    const { prisma, service } = createService();
    prisma.billingPlan.findFirst.mockResolvedValue({
      providerPlanId: 'plan-managed',
      amount: 12_345,
      currency: 'INR',
    });
    const fetchPlan = vi.fn().mockResolvedValue({
      item: { amount: 12_345, currency: 'INR' },
    });
    const createSubscription = vi.fn().mockResolvedValue({ id: 'sub-managed' });
    Object.defineProperty(service, 'razorpay', {
      value: {
        plans: { fetch: fetchPlan },
        subscriptions: { create: createSubscription },
      },
    });

    const checkout = await service.createCheckout('user-1', 'pro', 'monthly');

    expect(fetchPlan).toHaveBeenCalledWith('plan-managed');
    expect(createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan-managed',
      notes: expect.objectContaining({ plan: 'pro', interval: 'monthly' }),
    }));
    expect(prisma.subscription.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerPlanId: 'plan-managed',
        tier: 'pro',
        billingInterval: 'monthly',
      }),
    }));
    expect(checkout).toMatchObject({ provider: 'razorpay', subscriptionId: 'sub-managed' });
  });

  it('rejects a checkout when the displayed price no longer matches the active plan', async () => {
    const { prisma, service } = createService();
    prisma.billingPlan.findFirst.mockResolvedValue({
      providerPlanId: 'plan-managed',
      amount: 12_345,
      currency: 'INR',
    });
    const fetchPlan = vi.fn();
    Object.defineProperty(service, 'razorpay', {
      value: { plans: { fetch: fetchPlan } },
    });

    await expect(
      service.createCheckout('user-1', 'pro', 'monthly', 9_999),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fetchPlan).not.toHaveBeenCalled();
  });

  it('publishes the active managed price without exposing provider plan IDs', async () => {
    const { prisma, service } = createService();
    prisma.billingPlan.findMany.mockResolvedValue([
      { tier: 'pro', interval: 'monthly', amount: 45_000, currency: 'INR' },
    ]);

    const prices = await service.listPublicPricing();

    expect(prices).toContainEqual({
      tier: 'pro',
      interval: 'monthly',
      amount: 45_000,
      currency: 'INR',
    });
    expect(prices).toHaveLength(4);
    expect(JSON.stringify(prices)).not.toContain('providerPlanId');
  });
});
