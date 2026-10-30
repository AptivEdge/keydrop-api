import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';
import { AdminDeliverabilityService } from './admin-deliverability.service.js';

@ApiTags('Admin Deliverability')
@Controller('admin/v1/deliverability')
@AuthRoles('ENG', 'ADM')
export class AdminDeliverabilityController {
  constructor(private readonly deliverability: AdminDeliverabilityService) {}

  @Get()
  @ApiOperation({
    summary: 'Get email provider configuration and notification retry state',
  })
  getDeliverability() {
    return this.deliverability.getDeliverability();
  }
}
