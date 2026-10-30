import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../common/auth/decorators/public.decorator.js';
import { BillingService } from './billing.service.js';

@Controller('billing')
export class BillingPricingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @Public()
  @Header('Cache-Control', 'no-store')
  listPlans() {
    return this.billing.listPublicPricing();
  }
}
