import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { CursorPaginationDto } from '../common/dto/cursor-pagination.dto.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import { BillingService } from './billing.service.js';
import {
  ChangePlanDto,
  CheckoutDto,
  VerifyCheckoutDto,
} from './dto/billing.dto.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Billing')
@ApiBearerAuth('supabase')
@Controller('me/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequireApiKeyScope('billing:read')
  @ApiOperation({ summary: 'Get the current billing overview' })
  @ApiResponse({
    status: 200,
    description:
      'Returns the user plan and most recently created subscription, or null when none exists.',
    schema: {
      type: 'object',
      required: ['plan', 'subscription'],
      properties: {
        plan: { type: 'string', enum: ['free', 'pro', 'team'] },
        subscription: { ...subscriptionSchema(), nullable: true },
      },
    },
  })
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.overview(user.userId);
  }

  @Get('subscriptions')
  @RequireApiKeyScope('billing:read')
  @ApiOperation({ summary: 'List subscriptions' })
  @ApiResponse({
    status: 200,
    description: 'Returns the user subscriptions, newest first.',
    schema: { type: 'array', items: subscriptionSchema() },
  })
  subscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.listSubscriptions(user.userId);
  }

  @Get('invoices')
  @RequireApiKeyScope('billing:read')
  @ApiOperation({ summary: 'List invoices' })
  @ApiResponse({
    status: 200,
    description:
      'Returns a cursor-paginated page of invoices, newest issue date first.',
    schema: {
      type: 'object',
      required: ['items', 'nextCursor'],
      properties: {
        items: { type: 'array', items: invoiceSchema() },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.billing.listInvoices(user.userId, query.cursor, query.limit);
  }

  @Get('refunds')
  @RequireApiKeyScope('billing:read')
  @ApiOperation({ summary: 'List refunds synchronized from Razorpay' })
  refunds(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.billing.listRefunds(user.userId, query.cursor, query.limit);
  }

  @Delete('subscriptions/:id')
  @RequireApiKeyScope('billing:write')
  @ApiOperation({ summary: 'Cancel a subscription' })
  @ApiResponse({
    status: 200,
    description:
      'Schedules cancellation at the end of the current paid period. The subscription stays active until then.',
    schema: {
      type: 'object',
      required: [
        'id',
        'status',
        'cancelAtPeriodEnd',
        'currentPeriodEnd',
        'updatedAt',
      ],
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        cancelAtPeriodEnd: { type: 'boolean', enum: [true] },
        currentPeriodEnd: {
          type: 'string',
          format: 'date-time',
          nullable: true,
        },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.billing.cancelSubscription(user.userId, id);
  }

  @Post('subscriptions/:id/change-plan')
  @RequireApiKeyScope('billing:write')
  @ApiOperation({
    summary: 'Schedule a subscription plan change for the billing cycle end',
  })
  @ApiResponse({
    status: 201,
    description:
      'Returns the current plan and the target plan scheduled for the current cycle end.',
  })
  changePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: ChangePlanDto,
  ) {
    return this.billing.changeSubscriptionPlan(
      user.userId,
      id,
      body.plan,
      body.interval,
    );
  }

  @Post('checkout')
  @RequireApiKeyScope('billing:write')
  @RateLimit('checkout')
  @ApiOperation({ summary: 'Create a Razorpay subscription checkout' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the Razorpay checkout details for the selected plan and billing interval.',
    schema: {
      type: 'object',
      required: [
        'provider',
        'subscriptionId',
        'plan',
        'interval',
        'currency',
        'email',
      ],
      properties: {
        provider: { type: 'string', enum: ['razorpay'] },
        keyId: { type: 'string', nullable: true },
        subscriptionId: { type: 'string' },
        plan: { type: 'string', enum: ['pro', 'team'] },
        interval: { type: 'string', enum: ['monthly', 'yearly'] },
        currency: { type: 'string', enum: ['INR'] },
        email: { type: 'string', format: 'email' },
      },
    },
  })
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: CheckoutDto) {
    return this.billing.createCheckout(
      user.userId,
      body.plan,
      body.interval,
      body.expectedAmount,
    );
  }

  @Post('verify')
  @RequireApiKeyScope('billing:write')
  @RateLimit('checkout')
  @ApiOperation({ summary: 'Verify Razorpay checkout signature' })
  @ApiResponse({
    status: 201,
    description:
      'Verifies the checkout signature and synchronizes the subscription from Razorpay when its state is available.',
    schema: {
      type: 'object',
      required: ['verified', 'activated', 'webhookRequired', 'plan'],
      properties: {
        verified: { type: 'boolean', enum: [true] },
        activated: { type: 'boolean' },
        webhookRequired: { type: 'boolean' },
        plan: { type: 'string', enum: ['free', 'pro', 'team'] },
      },
    },
  })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: VerifyCheckoutDto,
  ) {
    return this.billing.verifyCheckoutSignature(
      user.userId,
      body.subscriptionId,
      body.paymentId,
      body.signature,
    );
  }

  @Post('refresh')
  @RequireApiKeyScope('billing:write')
  @RateLimit('checkout')
  @ApiOperation({
    summary: 'Refresh the current user subscription state from Razorpay',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns the current plan and most recently created subscription after provider synchronization.',
  })
  refresh(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.refreshBillingStatus(user.userId);
  }
}

function subscriptionSchema() {
  return {
    type: 'object' as const,
    required: [
      'id',
      'planId',
      'tier',
      'billingInterval',
      'pendingTier',
      'pendingInterval',
      'cancelAtPeriodEnd',
      'status',
      'currentPeriodStart',
      'currentPeriodEnd',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      planId: { type: 'string' },
      tier: { type: 'string', enum: ['free', 'pro', 'team'] },
      billingInterval: {
        type: 'string',
        enum: ['monthly', 'yearly'],
        nullable: true,
      },
      currency: { type: 'string', enum: ['INR'] },
      pendingTier: {
        type: 'string',
        enum: ['pro', 'team'],
        nullable: true,
      },
      pendingInterval: {
        type: 'string',
        enum: ['monthly', 'yearly'],
        nullable: true,
      },
      cancelAtPeriodEnd: { type: 'boolean' },
      status: { type: 'string' },
      currentPeriodStart: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
      currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function invoiceSchema() {
  return {
    type: 'object' as const,
    required: [
      'id',
      'subscriptionId',
      'amount',
      'currency',
      'status',
      'issuedAt',
      'paidAt',
      'externalId',
      'createdAt',
    ],
    properties: {
      id: { type: 'string' },
      subscriptionId: { type: 'string', nullable: true },
      amount: { type: 'integer' },
      currency: { type: 'string' },
      status: { type: 'string' },
      issuedAt: { type: 'string', format: 'date-time' },
      paidAt: { type: 'string', format: 'date-time', nullable: true },
      externalId: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}
