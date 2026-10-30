import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { BillingService } from './billing.service.js';
import {
  CreateAdminBillingPlanDto,
  RefundDto,
} from './dto/billing.dto.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Admin')
@ApiBearerAuth('supabase')
@Controller('admin/billing')
@AuthRoles('BIL', 'ADM')
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List managed Razorpay plans' })
  listPlans() {
    return this.billing.listAdminBillingPlans();
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create and activate a Razorpay plan' })
  createPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAdminBillingPlanDto,
  ) {
    return this.billing.createAdminBillingPlan(body, user);
  }

  @Post('refunds')
  @ApiOperation({ summary: 'Refund a Razorpay payment (billing staff)' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the refund identifier, payment identifier, status, amount, and currency.',
    schema: {
      type: 'object',
      required: ['id', 'paymentId', 'status', 'amount', 'currency'],
      properties: {
        id: { type: 'string' },
        paymentId: { type: 'string' },
        status: { type: 'string' },
        amount: { type: 'integer' },
        currency: { type: 'string' },
      },
    },
  })
  refund(@CurrentUser() user: AuthenticatedUser, @Body() body: RefundDto) {
    return this.billing.refundPayment(
      user.userId,
      body.paymentId,
      body.amount,
      body.reason,
    );
  }
}
