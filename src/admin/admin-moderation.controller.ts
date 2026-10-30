import {
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Query,
  Body,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { ModerationReasonDto } from '../users/dto/moderation-reason.dto.js';
import { AdminModerationService } from './admin-moderation.service.js';
import {
  CreateAdminApprovalDto,
  ModerateAdminEntityDto,
  ReviewAdminApprovalDto,
  UpdateAbuseReportDto,
} from './admin-moderation.dto.js';

@ApiTags('Admin moderation')
@ApiBearerAuth('supabase')
@Controller('admin')
export class AdminModerationController {
  constructor(
    private readonly moderation: AdminModerationService,
    private readonly secrets: SecretsService,
  ) {}

  @Get('users/:id/moderation')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Get user moderation context without secret contents' })
  getUserModeration(@Param('id') id: string) {
    return this.moderation.getUserModeration(id);
  }

  @Post('users/:id/moderation')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Record a user moderation action' })
  moderateUser(
    @Param('id') id: string,
    @Body() dto: ModerateAdminEntityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.moderation.moderateUser(id, dto, actor);
  }

  @Post('teams/:id/moderation')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Record a team moderation action' })
  moderateTeam(
    @Param('id') id: string,
    @Body() dto: ModerateAdminEntityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.moderation.moderateTeam(id, dto, actor);
  }

  @Get('abuse')
  @AuthRoles('TS', 'ADM')
  @ApiOperation({ summary: 'List abuse reports for staff triage' })
  listReports(@Query('status') status?: string) {
    return this.moderation.listReports(status);
  }

  @Get('abuse/:id')
  @AuthRoles('TS', 'ADM')
  @ApiOperation({ summary: 'Read abuse report and related metadata' })
  getReport(@Param('id') id: string) {
    return this.moderation.getReport(id);
  }

  @Patch('abuse/:id')
  @AuthRoles('TS', 'ADM')
  @ApiOperation({ summary: 'Assign or update an abuse report' })
  updateReport(
    @Param('id') id: string,
    @Body() dto: UpdateAbuseReportDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.moderation.updateReport(id, dto, actor);
  }

  @Get('audit')
  @AuthRoles('ADM', 'AUD')
  @ApiOperation({ summary: 'List staff audit records' })
  listAuditLog() {
    return this.moderation.listAuditLog();
  }

  @Get('approvals')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'List staff approval requests' })
  listApprovals() {
    return this.moderation.listApprovals();
  }

  @Patch('approvals/:id')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Approve or reject another Admin’s request' })
  reviewApproval(
    @Param('id') id: string,
    @Body() dto: ReviewAdminApprovalDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.moderation.reviewApproval(id, dto, actor);
  }

  @Post('approvals')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Create an approval request' })
  createApproval(
    @Body() dto: CreateAdminApprovalDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.moderation.createApproval(dto, actor);
  }

  @Patch('secrets/:id/revoke')
  @AuthRoles('TS', 'ADM')
  @ApiOperation({ summary: 'Revoke a secret without reading its contents' })
  async revokeSecret(
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.secrets.revokeByStaff(id, actor.userId, dto.reason);
    return { ok: true };
  }
}
