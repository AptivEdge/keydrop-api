import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { ModerationReasonDto } from '../users/dto/moderation-reason.dto.js';
import {
  CreateAdminBlocklistEntryDto,
  CreateAdminDataRequestDto,
  UpdateAdminDataRequestDto,
} from './admin-operations.dto.js';
import { AdminOperationsService } from './admin-operations.service.js';

@Controller('admin')
@AuthRoles('ADM')
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  @Get('teams')
  listTeams() {
    return this.operations.listTeams();
  }

  @Get('teams/:id')
  getTeam(@Param('id') id: string) {
    return this.operations.getTeam(id);
  }

  @Get('secrets/:id')
  getSecretMetadata(@Param('id') id: string) {
    return this.operations.getSecretMetadata(id);
  }

  @Get('billing/subscriptions')
  listSubscriptions(@Query('status') status?: string) {
    return this.operations.listSubscriptions(status);
  }

  @Get('billing/invoices')
  listInvoices(@Query('status') status?: string) {
    return this.operations.listInvoices(status);
  }

  @Get('billing/refunds')
  listRefunds() {
    return this.operations.listRefunds();
  }

  @Get('data-requests')
  listDataRequests() {
    return this.operations.listDataRequests();
  }

  @Post('data-requests')
  createDataRequest(
    @Body() dto: CreateAdminDataRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.createDataRequest(dto, actor);
  }

  @Patch('data-requests/:id')
  updateDataRequest(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDataRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.updateDataRequest(id, dto, actor);
  }

  @Get('blocklists')
  listBlocklist() {
    return this.operations.listBlocklist();
  }

  @Post('blocklists')
  createBlocklistEntry(
    @Body() dto: CreateAdminBlocklistEntryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.createBlocklistEntry(dto, actor);
  }

  @Delete('blocklists/:id')
  deleteBlocklistEntry(
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.operations.deleteBlocklistEntry(id, dto.reason, actor);
  }
}
