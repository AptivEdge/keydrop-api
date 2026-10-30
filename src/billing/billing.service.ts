import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeNotificationPreferences } from '../common/notifications/notification-preferences.js';
import {
  cursorPage,
  cursorPaginationArgs,
} from '../common/dto/cursor-pagination.dto.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import type { CreateAdminBillingPlanDto } from './dto/billing.dto.js';

@Injectable()
export class BillingService {
  private readonly razorpay?: Razorpay;
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const keyId = this.config.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET');
    if (keyId && keySecret) {
      this.razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  listAdminBillingPlans() {
    return this.prisma.billingPlan.findMany({
      select: {
        id: true,
        tier: true,
        interval: true,
        providerPlanId: true,
        name: true,
        amount: true,
        currency: true,
        active: true,
        createdAt: true,
      },
      orderBy: [{ active: 'desc' }, { tier: 'asc' }, { interval: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async listPublicPricing() {
    const managedPlans = await this.prisma.billingPlan.findMany({
      where: { active: true },
      select: { tier: true, interval: true, amount: true, currency: true },
    });
    const configured = new Map(
      managedPlans.map((plan) => [`${plan.tier}:${plan.interval}`, plan]),
    );
    const fallbackPrices = {
      pro: { monthly: 29_900, yearly: 299_000 },
      team: { monthly: 99_900, yearly: 999_000 },
    } as const;
    return (['pro', 'team'] as const).flatMap((tier) =>
      (['monthly', 'yearly'] as const).map((interval) => {
        const plan = configured.get(`${tier}:${interval}`);
        return {
          tier,
          interval,
          amount: plan?.amount ?? fallbackPrices[tier][interval],
          currency: plan?.currency ?? 'INR',
        };
      }),
    );
  }

  async createAdminBillingPlan(
    dto: CreateAdminBillingPlanDto,
    actor: AuthenticatedUser,
  ) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }

    const name = dto.name.trim();
    const description = dto.description?.trim();
    const reason = dto.reason.trim();
    if (
      name.length < 1 ||
      name.length > 80 ||
      reason.length < 10 ||
      reason.length > 1000 ||
      !Number.isSafeInteger(dto.amount) ||
      dto.amount < 100 ||
      dto.amount > 100_000_000 ||
      (description?.length ?? 0) > 255
    ) {
      throw new BadRequestException('Plan details or price are invalid');
    }
    const providerPlan = await this.razorpay.plans.create({
      period: dto.interval,
      interval: 1,
      item: {
        name,
        amount: dto.amount,
        currency: 'INR',
        ...(description ? { description } : {}),
      },
      notes: {
        keydrop_tier: dto.tier,
        keydrop_interval: dto.interval,
      },
    });
    if (
      !providerPlan.id ||
      providerPlan.item?.amount !== dto.amount ||
      providerPlan.item?.currency !== 'INR' ||
      providerPlan.period !== dto.interval ||
      providerPlan.interval !== 1
    ) {
      throw new ServiceUnavailableException(
        'Razorpay returned a plan that does not match the requested price and billing period',
      );
    }

    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.billingPlan.updateMany({
          where: { tier: dto.tier, interval: dto.interval, active: true },
          data: { active: false },
        });
        const plan = await transaction.billingPlan.create({
          data: {
            tier: dto.tier,
            interval: dto.interval,
            providerPlanId: providerPlan.id,
            name,
            amount: dto.amount,
            currency: 'INR',
            createdById: actor.userId,
          },
          select: {
            id: true,
            tier: true,
            interval: true,
            providerPlanId: true,
            name: true,
            amount: true,
            currency: true,
            active: true,
            createdAt: true,
          },
        });
        await transaction.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: 'billing_plan_created',
            targetType: 'billing_plan',
            targetId: plan.id,
            reason,
            metadata: {
              tier: dto.tier,
              interval: dto.interval,
              providerPlanId: providerPlan.id,
              amount: dto.amount,
              currency: 'INR',
            },
          },
        });
        return plan;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async overview(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId },
      select: {
        id: true,
        planId: true,
        tier: true,
        billingInterval: true,
        currency: true,
        pendingTier: true,
        pendingInterval: true,
        cancelAtPeriodEnd: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { plan: user.plan, subscription };
  }

  listSubscriptions(userId: string) {
    return this.prisma.subscription.findMany({
      where: { userId },
      select: {
        id: true,
        planId: true,
        tier: true,
        billingInterval: true,
        currency: true,
        pendingTier: true,
        pendingInterval: true,
        cancelAtPeriodEnd: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listInvoices(userId: string, cursor?: string, limit = 50) {
    const rows = await this.prisma.invoice.findMany({
      where: { userId },
      select: {
        id: true,
        subscriptionId: true,
        amount: true,
        currency: true,
        status: true,
        issuedAt: true,
        paidAt: true,
        externalId: true,
        createdAt: true,
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async listRefunds(userId: string, cursor?: string, limit = 50) {
    const rows = await this.prisma.billingRefund.findMany({
      where: { userId },
      select: {
        id: true,
        externalId: true,
        paymentId: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async cancelSubscription(userId: string, subscriptionId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, userId },
      select: {
        id: true,
        status: true,
        planId: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: true,
      },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');
    if (subscription.status === 'canceled') {
      throw new ConflictException('Subscription is already canceled');
    }
    if (subscription.cancelAtPeriodEnd) {
      throw new ConflictException('Subscription cancellation is already scheduled');
    }
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    await this.razorpay.subscriptions.cancel(subscription.planId, true);
    return this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
      select: {
        id: true,
        status: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: true,
        updatedAt: true,
      },
    });
  }

  async cancelSubscriptionsForAccountDeletion(userId: string): Promise<void> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { userId, status: { not: 'canceled' } },
      select: { id: true, planId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (subscriptions.length === 0) return;
    if (!this.razorpay) {
      throw new ServiceUnavailableException(
        'Razorpay must be configured to cancel active subscriptions before account deletion',
      );
    }
    for (const subscription of subscriptions) {
      await this.razorpay.subscriptions.cancel(subscription.planId, false);
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'canceled' },
      });
    }
  }

  async createCheckout(
    userId: string,
    plan: 'pro' | 'team',
    interval: 'monthly' | 'yearly',
    expectedAmount?: number,
  ) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const currency: BillingCurrency = 'INR';
    const configured = await this.getConfiguredProviderPlan(plan, interval);
    if (!configured) {
      throw new ServiceUnavailableException(
        `Razorpay ${currency} plan is not configured`,
      );
    }
    if (
      expectedAmount !== undefined &&
      expectedAmount !== configured.amount
    ) {
      throw new ConflictException(
        'The plan price has changed. Refresh the pricing page before continuing.',
      );
    }
    const planId = configured.providerPlanId;
    const providerPlan = await this.razorpay.plans.fetch(planId);
    if (
      providerPlan.item?.amount !== configured.amount
      || providerPlan.item?.currency !== configured.currency
    ) {
      throw new ServiceUnavailableException(
        `Razorpay ${currency} plan does not match the published ${plan} ${interval} price`,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const existing = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'Change the plan on the existing subscription instead of creating another checkout',
      );
    }
    const subscription = await this.razorpay.subscriptions.create({
      plan_id: planId,
      total_count: interval === 'yearly' ? 10 : 120,
      customer_notify: 1,
      notes: { userId, plan, interval, currency },
    });
    await this.prisma.subscription.create({
      data: {
        userId,
        planId: String(subscription.id),
        providerPlanId: planId,
        tier: plan,
        billingInterval: interval,
        currency,
        status: 'incomplete',
      },
    });
    return {
      provider: 'razorpay',
      keyId: this.config.get<string>('RAZORPAY_KEY_ID'),
      subscriptionId: subscription.id,
      plan,
      interval,
      currency,
      email: user.email,
    };
  }

  async changeSubscriptionPlan(
    userId: string,
    subscriptionId: string,
    plan: 'pro' | 'team',
    interval: 'monthly' | 'yearly',
  ) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, userId },
      select: {
        id: true,
        planId: true,
        status: true,
        providerPlanId: true,
        tier: true,
        billingInterval: true,
        currency: true,
        pendingProviderPlanId: true,
      },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');
    if (subscription.status !== 'active') {
      throw new ConflictException('Only active subscriptions can change plans');
    }
    if (subscription.pendingProviderPlanId) {
      throw new ConflictException(
        'A plan change is already scheduled for this subscription',
      );
    }
    if (subscription.currency !== 'INR') {
      throw new ConflictException(
        'Only INR subscriptions can be changed with this API',
      );
    }
    const configured = await this.getConfiguredProviderPlan(plan, interval);
    if (!configured) {
      throw new ServiceUnavailableException(
        'Razorpay INR plan is not configured',
      );
    }
    const providerPlanId = configured.providerPlanId;
    if (
      subscription.providerPlanId === providerPlanId ||
      (subscription.tier === plan && subscription.billingInterval === interval)
    ) {
      throw new ConflictException('Subscription already uses this plan');
    }

    await this.razorpay.subscriptions.update(subscription.planId, {
      plan_id: providerPlanId,
      schedule_change_at: 'cycle_end',
      customer_notify: 1,
    });
    return this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        pendingTier: plan,
        pendingInterval: interval,
        pendingProviderPlanId: providerPlanId,
      },
      select: {
        id: true,
        tier: true,
        billingInterval: true,
        pendingTier: true,
        pendingInterval: true,
        currentPeriodEnd: true,
        status: true,
      },
    });
  }

  async refundPayment(
    staffUserId: string,
    paymentId: string,
    amount: number | undefined,
    reason: string,
  ) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    if (!paymentId?.trim()) {
      throw new BadRequestException('paymentId is required');
    }
    const trimmedReason = reason?.trim();
    if (!trimmedReason || trimmedReason.length > 1000) {
      throw new BadRequestException(
        'A written refund reason between 1 and 1000 characters is required',
      );
    }
    if (
      amount !== undefined &&
      (!Number.isSafeInteger(amount) || amount <= 0)
    ) {
      throw new BadRequestException(
        'amount must be a positive integer in the smallest currency unit',
      );
    }
    const refund = await this.razorpay.payments.refund(paymentId.trim(), {
      ...(amount === undefined ? {} : { amount }),
      notes: { reason: trimmedReason, initiatedBy: staffUserId },
    });
    await this.prisma.auditEvent.create({
      data: {
        eventType: 'billing_refunded',
        actorId: staffUserId,
        device: `razorpay:${refund.id}`,
      },
    });
    return {
      id: refund.id,
      paymentId: refund.payment_id,
      status: refund.status,
      amount: refund.amount,
      currency: refund.currency,
    };
  }

  async verifyCheckoutSignature(
    userId: string,
    subscriptionId: string,
    paymentId: string,
    signature: string,
  ) {
    const secret = this.config.get<string>('RAZORPAY_KEY_SECRET');
    if (!secret)
      throw new ServiceUnavailableException('Razorpay is not configured');
    const expected = createHmac('sha256', secret)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');
    if (!safeEqual(expected, signature)) {
      throw new BadRequestException('Invalid payment signature');
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { planId: subscriptionId, userId },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');

    const refreshed = await this.refreshProviderSubscription(
      userId,
      subscriptionId,
    );
    const activated = refreshed.status === 'active';
    const { plan } = await this.overview(userId);
    return {
      verified: true,
      activated,
      webhookRequired: !activated,
      plan,
    };
  }

  async refreshBillingStatus(userId: string) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        userId,
        status: { in: ['active', 'past_due', 'incomplete', 'trialing'] },
      },
      select: { planId: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    for (const subscription of subscriptions) {
      await this.refreshProviderSubscription(userId, subscription.planId);
    }
    return this.overview(userId);
  }

  private async refreshProviderSubscription(
    userId: string,
    providerSubscriptionId: string,
  ) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const subscription = await this.prisma.subscription.findFirst({
      where: { planId: providerSubscriptionId, userId },
      select: {
        id: true,
        planId: true,
        providerPlanId: true,
        pendingProviderPlanId: true,
        pendingTier: true,
        pendingInterval: true,
      },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');

    const fetchStartedAt = new Date();
    const remote =
      await this.razorpay.subscriptions.fetch(providerSubscriptionId);
    if (remote.id !== providerSubscriptionId) {
      throw new ServiceUnavailableException(
        'Razorpay returned a different subscription than requested',
      );
    }

    const status = mapProviderSubscriptionStatus(remote.status);
    const configuredPlan = await this.configuredPlan(remote.plan_id);
    if (remote.status === 'active' && !configuredPlan) {
      throw new ServiceUnavailableException(
        'The active Razorpay subscription does not match a configured Keydrop plan',
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      const latest = await transaction.subscription.findUnique({
        where: { id: subscription.id },
        select: {
          lastProviderEventAt: true,
          pastDueSince: true,
          pendingProviderPlanId: true,
          pendingTier: true,
          pendingInterval: true,
        },
      });
      if (!latest) throw new NotFoundException('Subscription not found');

      if (
        latest.lastProviderEventAt &&
        latest.lastProviderEventAt > fetchStartedAt
      ) {
        return transaction.subscription.findUniqueOrThrow({
          where: { id: subscription.id },
          select: { status: true, tier: true },
        });
      }

      const planChangeConfirmed =
        !!latest.pendingProviderPlanId &&
        remote.plan_id === latest.pendingProviderPlanId;
      const updated = await transaction.subscription.update({
        where: { id: subscription.id },
        data: {
          status,
          ...(status === 'past_due'
            ? { pastDueSince: latest.pastDueSince ?? fetchStartedAt }
            : status === 'active'
              ? { pastDueSince: null }
              : {}),
          ...(!latest.pendingProviderPlanId || planChangeConfirmed
            ? { providerPlanId: remote.plan_id }
            : {}),
          ...(planChangeConfirmed
            ? {
                tier: latest.pendingTier ?? configuredPlan?.tier,
                billingInterval:
                  latest.pendingInterval ?? configuredPlan?.interval,
                pendingTier: null,
                pendingInterval: null,
                pendingProviderPlanId: null,
              }
            : configuredPlan && !latest.pendingProviderPlanId
              ? {
                  tier: configuredPlan.tier,
                  billingInterval: configuredPlan.interval,
                  currency: configuredPlan.currency,
                }
              : {}),
          currentPeriodStart: remote.current_start
            ? new Date(remote.current_start * 1000)
            : undefined,
          currentPeriodEnd: remote.current_end
            ? new Date(remote.current_end * 1000)
            : undefined,
          cancelAtPeriodEnd:
            status === 'canceled'
              ? false
              : readCancelAtCycleEnd(remote),
        },
        select: { status: true, tier: true },
      });
      if (status === 'active' || status === 'canceled') {
        await this.synchronizeUserPlan(transaction, userId);
      }
      return updated;
    });
  }

  async reconcilePastDueSubscriptions(): Promise<void> {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: 'past_due', pastDueSince: { lte: cutoff } },
      select: { id: true, planId: true, userId: true },
      orderBy: { pastDueSince: 'asc' },
      take: 100,
    });
    for (const subscription of subscriptions) {
      try {
        const latest = await this.prisma.subscription.findUnique({
          where: { id: subscription.id },
          select: { status: true, pastDueSince: true },
        });
        if (
          latest?.status !== 'past_due' ||
          !latest.pastDueSince ||
          latest.pastDueSince > cutoff
        ) {
          continue;
        }
        const remote = await this.razorpay.subscriptions.fetch(
          subscription.planId,
        );
        if (remote.status === 'active') {
          await this.prisma.$transaction(async (transaction) => {
            await transaction.subscription.update({
              where: { id: subscription.id },
              data: { status: 'active', pastDueSince: null },
            });
            await this.synchronizeUserPlan(transaction, subscription.userId);
          });
          continue;
        }
        if (
          remote.status === 'cancelled' ||
          remote.status === 'completed' ||
          remote.status === 'expired'
        ) {
          await this.prisma.$transaction(async (transaction) => {
            await transaction.subscription.update({
              where: { id: subscription.id },
              data: { status: 'canceled' },
            });
            await this.synchronizeUserPlan(transaction, subscription.userId);
          });
          continue;
        }
        await this.razorpay.subscriptions.cancel(subscription.planId, false);
        await this.prisma.$transaction(async (transaction) => {
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { status: 'canceled' },
          });
          await this.synchronizeUserPlan(transaction, subscription.userId);
        });
      } catch (error) {
        this.logger.error(
          `Failed to cancel past-due subscription ${subscription.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async reconcileBilling(): Promise<void> {
    if (!this.razorpay) {
      throw new ServiceUnavailableException('Razorpay is not configured');
    }
    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['active', 'past_due', 'incomplete', 'trialing'] },
        updatedAt: { lte: staleBefore },
      },
      select: {
        id: true,
        userId: true,
        cancelAtPeriodEnd: true,
        planId: true,
        pendingProviderPlanId: true,
        pendingTier: true,
        pendingInterval: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });
    for (const subscription of subscriptions) {
      try {
        const fetchStartedAt = new Date();
        const remote = await this.razorpay.subscriptions.fetch(
          subscription.planId,
        );
        const status = mapProviderSubscriptionStatus(remote.status);
        const planChangeConfirmed =
          !!subscription.pendingProviderPlanId &&
          remote.plan_id === subscription.pendingProviderPlanId;
        const configuredPlan =
          subscription.pendingProviderPlanId && !planChangeConfirmed
            ? undefined
            : await this.configuredPlan(remote.plan_id);
        await this.prisma.$transaction(async (transaction) => {
          const existing = await transaction.subscription.findUnique({
            where: { id: subscription.id },
            select: { pastDueSince: true, lastProviderEventAt: true },
          });
          if (
            existing?.lastProviderEventAt &&
            existing.lastProviderEventAt > fetchStartedAt
          ) {
            return;
          }
          const updated = await transaction.subscription.update({
            where: { id: subscription.id },
            data: {
              status,
              ...(!subscription.pendingProviderPlanId || planChangeConfirmed
                ? { providerPlanId: remote.plan_id }
                : {}),
              ...(configuredPlan
                ? {
                    tier: planChangeConfirmed
                      ? (subscription.pendingTier ?? configuredPlan.tier)
                      : configuredPlan.tier,
                    billingInterval: planChangeConfirmed
                      ? (subscription.pendingInterval ??
                        configuredPlan.interval)
                      : configuredPlan.interval,
                    currency: configuredPlan.currency,
                  }
                : {}),
              ...(planChangeConfirmed
                ? {
                    pendingTier: null,
                    pendingInterval: null,
                    pendingProviderPlanId: null,
                  }
                : {}),
              currentPeriodStart: remote.current_start
                ? new Date(remote.current_start * 1000)
                : undefined,
              currentPeriodEnd: remote.current_end
                ? new Date(remote.current_end * 1000)
                : undefined,
              cancelAtPeriodEnd:
                status === 'canceled'
                  ? false
                  : readCancelAtCycleEnd(remote),
              pastDueSince:
                status === 'past_due'
                  ? (existing?.pastDueSince ?? new Date())
                  : null,
            },
            select: { tier: true },
          });
          if (status === 'active') {
            await transaction.user.update({
              where: { id: subscription.userId },
              data: { plan: updated.tier },
            });
          } else if (status === 'canceled') {
            await this.synchronizeUserPlan(transaction, subscription.userId);
          }
        });

        let skip = 0;
        while (true) {
          const invoices = await this.razorpay.invoices.all({
            subscription_id: subscription.planId,
            count: 100,
            skip,
          });
          for (const invoice of invoices.items) {
            await this.prisma.$transaction(async (transaction) => {
              await this.syncInvoice(transaction, invoice, undefined);
              if (invoice.payment_id) {
                await transaction.billingRefund.updateMany({
                  where: {
                    paymentId: invoice.payment_id,
                    userId: null,
                  },
                  data: { userId: subscription.userId },
                });
              }
            });
          }
          if (invoices.items.length < 100) break;
          skip += invoices.items.length;
        }
      } catch (error) {
        this.logger.error(
          `Billing reconciliation failed for subscription ${subscription.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async processWebhook(
    rawBody: Buffer,
    signature: string,
    eventId: string | undefined,
    payload: RazorpayWebhook,
  ) {
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    if (!secret)
      throw new ServiceUnavailableException(
        'Razorpay webhook secret is not configured',
      );
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(expected, signature)) {
      throw new BadRequestException('Invalid webhook signature');
    }
    if (
      !eventId?.trim() ||
      !payload?.account_id ||
      !Number.isSafeInteger(payload.created_at) ||
      payload.created_at! <= 0 ||
      !payload.event
    ) {
      throw new BadRequestException('Invalid webhook payload');
    }
    this.validateWebhookEventPayload(payload);
    const normalizedEventId = eventId.trim();

    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.billingWebhookEvent.create({
          data: {
            provider: 'razorpay',
            eventId: normalizedEventId,
            eventType: payload.event!,
          },
        });
        await this.applyWebhook(transaction, payload);
        await transaction.billingWebhookEvent.update({
          where: {
            provider_eventId: {
              provider: 'razorpay',
              eventId: normalizedEventId,
            },
          },
          data: { processedAt: new Date() },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.billingWebhookEvent.findUnique({
          where: {
            provider_eventId: {
              provider: 'razorpay',
              eventId: normalizedEventId,
            },
          },
        });
        if (existing) return { accepted: true, duplicate: true };
      }
      throw error;
    }
    return { accepted: true };
  }

  private async applyWebhook(
    prisma: Prisma.TransactionClient,
    payload: RazorpayWebhook,
  ) {
    const event = payload.event!;
    if (event.startsWith('subscription.')) {
      const entity = payload.payload?.subscription?.entity;
      if (entity?.id)
        await this.syncSubscriptionEvent(
          prisma,
          event,
          entity,
          payload.created_at!,
        );
    }
    if (event.startsWith('invoice.')) {
      const invoice = payload.payload?.invoice?.entity;
      if (invoice) await this.syncInvoice(prisma, invoice, payload.created_at);
    }
    if (
      event === 'payment.failed' ||
      event === 'payment.captured' ||
      event === 'payment.authorized'
    ) {
      const payment = payload.payload?.payment?.entity;
      if (payment) {
        await this.syncPaymentInvoice(
          prisma,
          event,
          payment,
          payload.created_at!,
        );
        if (event === 'payment.failed') {
          await this.markPaymentFailed(prisma, payment, payload.created_at!);
        }
      }
    }
    if (event.startsWith('refund.')) {
      const refund = payload.payload?.refund?.entity;
      if (refund) await this.syncRefund(prisma, refund, payload.created_at!);
    }
  }

  private validateWebhookEventPayload(payload: RazorpayWebhook) {
    const event = payload.event!;
    if (
      event.startsWith('subscription.') &&
      !payload.payload?.subscription?.entity?.id
    ) {
      throw new BadRequestException(
        'Subscription webhook is missing its subscription entity',
      );
    }
    if (event.startsWith('invoice.') && !payload.payload?.invoice?.entity?.id) {
      throw new BadRequestException(
        'Invoice webhook is missing its invoice entity',
      );
    }
    if (
      ['payment.failed', 'payment.captured', 'payment.authorized'].includes(
        event,
      ) &&
      !payload.payload?.payment?.entity?.id
    ) {
      throw new BadRequestException(
        'Payment webhook is missing its payment entity',
      );
    }
    if (event.startsWith('refund.')) {
      const refund = payload.payload?.refund?.entity;
      if (!refund?.id || !refund.payment_id) {
        throw new BadRequestException(
          'Refund webhook is missing its refund entity',
        );
      }
    }
  }

  private async syncSubscriptionEvent(
    prisma: Prisma.TransactionClient,
    event: string,
    entity: RazorpaySubscriptionEntity,
    webhookCreatedAt: number,
  ) {
    const subscription = await prisma.subscription.findFirst({
      where: { planId: entity.id },
      select: {
        id: true,
        userId: true,
        pastDueSince: true,
        pendingTier: true,
        pendingInterval: true,
        pendingProviderPlanId: true,
        lastProviderEventAt: true,
      },
    });
    if (!subscription) return;
    const providerEventAt = new Date(webhookCreatedAt * 1000);
    const planChangeConfirmed =
      event === 'subscription.charged' &&
      !!subscription.pendingProviderPlanId &&
      entity.plan_id === subscription.pendingProviderPlanId;
    if (
      subscription.lastProviderEventAt &&
      providerEventAt < subscription.lastProviderEventAt &&
      !planChangeConfirmed
    ) {
      return;
    }

    const status = mapRazorpayStatus(event);
    const configuredPlan = await this.configuredPlan(entity.plan_id);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        ...(status ? { status } : {}),
        ...(status === 'past_due'
          ? { pastDueSince: subscription.pastDueSince ?? providerEventAt }
          : status === 'active'
            ? { pastDueSince: null }
            : {}),
        lastProviderEventAt: providerEventAt,
        ...(!subscription.pendingProviderPlanId || planChangeConfirmed
          ? { providerPlanId: entity.plan_id }
          : {}),
        ...(planChangeConfirmed
          ? {
              tier: subscription.pendingTier ?? undefined,
              billingInterval: subscription.pendingInterval ?? undefined,
              pendingTier: null,
              pendingInterval: null,
              pendingProviderPlanId: null,
            }
          : configuredPlan && !subscription.pendingProviderPlanId
            ? {
                tier: configuredPlan.tier,
                billingInterval: configuredPlan.interval,
                currency: configuredPlan.currency,
              }
            : {}),
        currentPeriodStart: entity.current_start
          ? new Date(entity.current_start * 1000)
          : undefined,
        currentPeriodEnd: entity.current_end
          ? new Date(entity.current_end * 1000)
          : undefined,
        cancelAtPeriodEnd:
          status === 'canceled'
            ? false
            : readCancelAtCycleEnd(entity),
      },
    });
    if (status === 'active' || status === 'canceled') {
      await this.synchronizeUserPlan(prisma, subscription.userId);
    }
  }

  private async syncInvoice(
    prisma: Prisma.TransactionClient,
    invoice: RazorpayInvoiceEntity,
    webhookCreatedAt?: number,
  ) {
    if (
      !invoice.id ||
      !invoice.subscription_id ||
      !Number.isSafeInteger(Number(invoice.amount)) ||
      !invoice.currency
    ) {
      return;
    }
    const subscription = await prisma.subscription.findFirst({
      where: { planId: invoice.subscription_id },
      select: { id: true, userId: true, lastProviderEventAt: true },
    });
    if (!subscription) return;
    const status = mapInvoiceStatus(invoice.status);
    const providerUpdatedAt = webhookCreatedAt
      ? new Date(webhookCreatedAt * 1000)
      : invoice.paid_at
        ? new Date(invoice.paid_at * 1000)
        : invoice.issued_at
          ? new Date(invoice.issued_at * 1000)
          : undefined;
    const existingInvoice = await prisma.invoice.findUnique({
      where: { externalId: invoice.id },
      select: { providerUpdatedAt: true },
    });
    if (
      providerUpdatedAt &&
      existingInvoice?.providerUpdatedAt &&
      providerUpdatedAt < existingInvoice.providerUpdatedAt
    ) {
      return;
    }
    if (
      providerUpdatedAt &&
      (!subscription.lastProviderEventAt ||
        providerUpdatedAt >= subscription.lastProviderEventAt)
    ) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          lastProviderEventAt: providerUpdatedAt,
        },
      });
    }
    const paidAt = invoice.paid_at
      ? new Date(invoice.paid_at * 1000)
      : status === 'paid' && webhookCreatedAt
        ? new Date(webhookCreatedAt * 1000)
        : undefined;
    await prisma.invoice.upsert({
      where: { externalId: invoice.id },
      create: {
        externalId: invoice.id,
        paymentId: invoice.payment_id || undefined,
        providerUpdatedAt,
        subscriptionId: subscription.id,
        userId: subscription.userId,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status,
        issuedAt: invoice.issued_at
          ? new Date(invoice.issued_at * 1000)
          : webhookCreatedAt
            ? new Date(webhookCreatedAt * 1000)
            : new Date(),
        paidAt,
      },
      update: {
        paymentId: invoice.payment_id || undefined,
        providerUpdatedAt,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status,
        ...(paidAt ? { paidAt } : {}),
      },
    });
  }

  private async syncPaymentInvoice(
    prisma: Prisma.TransactionClient,
    event: string,
    payment: RazorpayPaymentEntity,
    webhookCreatedAt: number,
  ) {
    if (
      !payment.invoice_id ||
      !payment.subscription_id ||
      !Number.isSafeInteger(Number(payment.amount)) ||
      !payment.currency
    ) {
      return;
    }
    const subscription = await prisma.subscription.findFirst({
      where: { planId: payment.subscription_id },
      select: { id: true, userId: true, lastProviderEventAt: true },
    });
    if (!subscription) return;
    const providerUpdatedAt = new Date(webhookCreatedAt * 1000);
    const existingInvoice = await prisma.invoice.findUnique({
      where: { externalId: payment.invoice_id },
      select: { providerUpdatedAt: true },
    });
    if (
      existingInvoice?.providerUpdatedAt &&
      providerUpdatedAt < existingInvoice.providerUpdatedAt
    ) {
      return;
    }
    if (
      !subscription.lastProviderEventAt ||
      providerUpdatedAt >= subscription.lastProviderEventAt
    ) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { lastProviderEventAt: providerUpdatedAt },
      });
    }
    const paid = event === 'payment.captured';
    await prisma.invoice.upsert({
      where: { externalId: payment.invoice_id },
      create: {
        externalId: payment.invoice_id,
        paymentId: payment.id,
        providerUpdatedAt,
        subscriptionId: subscription.id,
        userId: subscription.userId,
        amount: Number(payment.amount),
        currency: payment.currency,
        status: paid ? 'paid' : 'open',
        issuedAt: new Date(webhookCreatedAt * 1000),
        paidAt: paid ? new Date(webhookCreatedAt * 1000) : null,
      },
      update: {
        paymentId: payment.id,
        providerUpdatedAt,
        amount: Number(payment.amount),
        currency: payment.currency,
        status: paid ? 'paid' : 'open',
        ...(paid ? { paidAt: new Date(webhookCreatedAt * 1000) } : {}),
      },
    });
  }

  private async markPaymentFailed(
    prisma: Prisma.TransactionClient,
    payment: RazorpayPaymentEntity,
    webhookCreatedAt: number,
  ) {
    if (!payment.subscription_id || !payment.id) return;
    const subscription = await prisma.subscription.findFirst({
      where: { planId: payment.subscription_id },
      select: {
        id: true,
        userId: true,
        pastDueSince: true,
        lastProviderEventAt: true,
      },
    });
    if (!subscription) return;
    const providerEventAt = new Date(webhookCreatedAt * 1000);
    if (
      subscription.lastProviderEventAt &&
      providerEventAt < subscription.lastProviderEventAt
    ) {
      return;
    }
    const now = new Date();
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'past_due',
        pastDueSince: subscription.pastDueSince ?? providerEventAt,
        lastProviderEventAt: providerEventAt,
      },
    });
    const user = await prisma.user.findUnique({
      where: { id: subscription.userId },
      select: { notificationPreferences: true },
    });
    if (!user) return;
    const preference = normalizeNotificationPreferences(
      user.notificationPreferences,
    ).billing_payment_failed;
    if (!preference.inApp && !preference.email) return;
    await prisma.notification.createMany({
      data: [
        {
          userId: subscription.userId,
          type: 'billing_payment_failed',
          dedupeKey: `billing_payment_failed:${payment.id}`,
          payload: {
            paymentId: payment.id,
            amount: payment.amount,
            currency: payment.currency,
          },
          emailSentAt: preference.email ? null : now,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async syncRefund(
    prisma: Prisma.TransactionClient,
    refund: RazorpayRefundEntity,
    webhookCreatedAt: number,
  ) {
    if (
      !refund.id ||
      !refund.payment_id ||
      !Number.isSafeInteger(Number(refund.amount)) ||
      !refund.currency ||
      !refund.status
    ) {
      return;
    }
    const invoice = await prisma.invoice.findUnique({
      where: { paymentId: refund.payment_id },
      select: { userId: true },
    });
    const existing = await prisma.billingRefund.findUnique({
      where: { externalId: refund.id },
      select: { providerUpdatedAt: true },
    });
    const providerUpdatedAt = new Date(webhookCreatedAt * 1000);
    if (
      existing?.providerUpdatedAt &&
      providerUpdatedAt < existing.providerUpdatedAt
    ) {
      return;
    }
    await prisma.billingRefund.upsert({
      where: { externalId: refund.id },
      create: {
        externalId: refund.id,
        paymentId: refund.payment_id,
        userId: invoice?.userId,
        amount: Number(refund.amount),
        currency: refund.currency,
        status: refund.status,
        providerUpdatedAt,
      },
      update: {
        ...(invoice ? { userId: invoice.userId } : {}),
        amount: Number(refund.amount),
        currency: refund.currency,
        status: refund.status,
        providerUpdatedAt,
      },
    });
  }

  private async synchronizeUserPlan(
    prisma: Prisma.TransactionClient,
    userId: string,
  ) {
    const subscriptions = await prisma.subscription.findMany({
      where: { userId, status: { in: ['active', 'trialing'] } },
      select: { tier: true },
    });
    const plan = subscriptions.reduce<UserPlan>(
      (highest, subscription) =>
        planRank(subscription.tier) > planRank(highest)
          ? subscription.tier
          : highest,
      'free',
    );
    await prisma.user.update({ where: { id: userId }, data: { plan } });
    if (plan === 'free') {
      await prisma.apiKey.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  private async getConfiguredProviderPlan(
    tier: 'pro' | 'team',
    interval: 'monthly' | 'yearly',
  ) {
    const managedPlan = await this.prisma.billingPlan?.findFirst({
      where: { tier, interval, active: true },
      select: { providerPlanId: true, amount: true, currency: true },
    });
    if (managedPlan) return managedPlan;

    const prefix = `RAZORPAY_${tier.toUpperCase()}_${interval.toUpperCase()}`;
    const providerPlanId = this.config.get<string>(`${prefix}_PLAN_ID`)
      ?? this.config.get<string>(`${prefix}_INR_PLAN_ID`);
    if (!providerPlanId) return undefined;
    const amount = {
      pro: { monthly: 29_900, yearly: 299_000 },
      team: { monthly: 99_900, yearly: 999_000 },
    }[tier][interval];
    return { providerPlanId, amount, currency: 'INR' };
  }

  private async configuredPlan(providerPlanId?: string) {
    if (!providerPlanId) return undefined;
    const managedPlan = await this.prisma.billingPlan?.findUnique({
      where: { providerPlanId },
      select: { tier: true, interval: true, currency: true },
    });
    if (managedPlan) return managedPlan;
    for (const tier of ['pro', 'team'] as const) {
      for (const interval of ['monthly', 'yearly'] as const) {
        const prefix = `RAZORPAY_${tier.toUpperCase()}_${interval.toUpperCase()}`;
        if (
          this.config.get<string>(`${prefix}_PLAN_ID`) === providerPlanId ||
          this.config.get<string>(`${prefix}_INR_PLAN_ID`) === providerPlanId
        ) {
          return { tier, interval, currency: 'INR' as const };
        }
      }
    }
    return undefined;
  }
}

type UserPlan = 'free' | 'pro' | 'team';
type BillingCurrency = 'INR';

type RazorpayWebhook = {
  event?: string;
  account_id?: string;
  created_at?: number;
  payload?: {
    subscription?: {
      entity?: {
        id?: string;
        plan_id?: string;
        status?: string;
        current_start?: number | null;
        current_end?: number | null;
        cancel_at_cycle_end?: boolean;
      };
    };
    payment?: { entity?: RazorpayPaymentEntity };
    invoice?: { entity?: RazorpayInvoiceEntity };
    refund?: { entity?: RazorpayRefundEntity };
  };
};

type RazorpaySubscriptionEntity = {
  id?: string;
  plan_id?: string;
  status?: string;
  current_start?: number | null;
  current_end?: number | null;
  cancel_at_cycle_end?: boolean;
};

type RazorpayPaymentEntity = {
  id?: string;
  invoice_id?: string | null;
  subscription_id?: string | null;
  amount?: number | string;
  currency?: string;
};

type RazorpayInvoiceEntity = {
  id?: string;
  subscription_id?: string;
  payment_id?: string | null;
  amount?: number | string;
  currency?: string;
  status?: string;
  issued_at?: number | null;
  paid_at?: number | null;
};

type RazorpayRefundEntity = {
  id?: string;
  payment_id?: string;
  amount?: number | string;
  currency?: string;
  status?: string;
};

function mapRazorpayStatus(event: string) {
  if (event === 'subscription.activated' || event === 'subscription.charged')
    return 'active' as const;
  if (event === 'subscription.halted') return 'past_due' as const;
  if (
    event === 'subscription.cancelled' ||
    event === 'subscription.completed' ||
    event === 'subscription.expired'
  ) {
    return 'canceled' as const;
  }
  return undefined;
}

function mapProviderSubscriptionStatus(status: string) {
  switch (status) {
    case 'active':
      return 'active' as const;
    case 'pending':
    case 'halted':
      return 'past_due' as const;
    case 'cancelled':
    case 'completed':
    case 'expired':
      return 'canceled' as const;
    default:
      return 'incomplete' as const;
  }
}

function readCancelAtCycleEnd(subscription: object): boolean | undefined {
  if (!('cancel_at_cycle_end' in subscription)) return undefined;
  const cancelAtCycleEnd = subscription.cancel_at_cycle_end;
  if (cancelAtCycleEnd === undefined) return undefined;
  if (typeof cancelAtCycleEnd !== 'boolean') {
    throw new Error('Razorpay returned an invalid cancellation state');
  }
  return cancelAtCycleEnd;
}

function mapInvoiceStatus(status?: string) {
  switch (status) {
    case 'paid':
      return 'paid' as const;
    case 'expired':
    case 'cancelled':
    case 'deleted':
      return 'void' as const;
    case 'uncollectible':
      return 'uncollectible' as const;
    default:
      return 'open' as const;
  }
}

function planRank(plan: UserPlan) {
  return plan === 'team' ? 2 : plan === 'pro' ? 1 : 0;
}

function safeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual ?? '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
