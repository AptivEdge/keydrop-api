import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AbuseReportStatus, Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { AccountService } from '../account/account.service.js';
import type {
  CreateAdminApprovalDto,
  ModerateAdminEntityDto,
  ReviewAdminApprovalDto,
  UpdateAbuseReportDto,
} from './admin-moderation.dto.js';

type AbuseStatus = AbuseReportStatus;

function isAbuseStatus(value: string): value is AbuseStatus {
  return Object.values(AbuseReportStatus).some((status) => status === value);
}

function normalizeModerationReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 10 || reason.length > 1000) {
    throw new BadRequestException('Reason must be between 10 and 1000 characters');
  }
  return reason;
}

const reportSummarySelect = {
  id: true,
  secretId: true,
  reason: true,
  details: true,
  status: true,
  severity: true,
  assigneeId: true,
  resolutionNote: true,
  createdAt: true,
  updatedAt: true,
  reporter: { select: { id: true, email: true } },
  secret: {
    select: {
      id: true,
      status: true,
      viewsUsed: true,
      maxViews: true,
      expiresAt: true,
      createdAt: true,
      owner: { select: { id: true, email: true, suspendedAt: true } },
    },
  },
} as const;

@Injectable()
export class AdminModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly accounts: AccountService,
  ) {}

  async getUserModeration(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        suspendedAt: true,
        suspensionReason: true,
        createdAt: true,
        teamMembers: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            team: {
              select: {
                id: true,
                name: true,
                suspendedAt: true,
                suspensionReason: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        apiKeys: {
          select: {
            id: true,
            name: true,
            scopes: true,
            lastUsedAt: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        secrets: {
          select: {
            id: true,
            status: true,
            maxViews: true,
            viewsUsed: true,
            expiresAt: true,
            createdAt: true,
            _count: { select: { abuseReports: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const [history, reports] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where: { targetType: 'user', targetId: id },
        select: {
          id: true,
          action: true,
          reason: true,
          metadata: true,
          createdAt: true,
          actor: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.abuseReport.findMany({
        where: { secret: { ownerId: id } },
        select: {
          id: true,
          reason: true,
          status: true,
          severity: true,
          createdAt: true,
          secret: { select: { id: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { user, history, reports };
  }

  async moderateUser(
    id: string,
    dto: ModerateAdminEntityDto,
    actor: AuthenticatedUser,
  ) {
    const reason = normalizeModerationReason(dto.reason);
    if (dto.action === 'note' || dto.action === 'warn') {
      await this.requireModeratableUser(id);
      return this.recordModerationEvent(
        actor.userId,
        'user',
        id,
        dto.action === 'warn' ? 'user_warned' : 'user_note_added',
        reason,
      );
    }
    if (dto.action === 'revoke_access') {
      const user = await this.requireModeratableUser(id);
      const activeSecrets = await this.prisma.secret.findMany({
        where: { ownerId: id, status: { in: ['active', 'partially_viewed'] } },
        select: { id: true },
      });
      const revokedKeys = await this.prisma.$transaction(async (tx) => {
        const result = await tx.apiKey.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: 'user_access_revocation_started',
            targetType: 'user',
            targetId: id,
            reason,
            metadata: {
              revokedApiKeys: result.count,
              activeSecrets: activeSecrets.length,
            },
          },
        });
        return result.count;
      });
      for (const secret of activeSecrets) {
        await this.secrets.revokeByStaff(secret.id, actor.userId, reason);
      }
      return { revokedApiKeys: revokedKeys, revokedSecrets: activeSecrets.length };
    }
    if (dto.action === 'delete') {
      await this.requireModeratableUser(id);
      await this.accounts.deleteAccount(id, {
        actorId: actor.userId,
        reason,
      });
      return { deleted: true };
    }
    throw new BadRequestException('Unsupported user moderation action');
  }

  async moderateTeam(
    id: string,
    dto: ModerateAdminEntityDto,
    actor: AuthenticatedUser,
  ) {
    const reason = normalizeModerationReason(dto.reason);
    const team = await this.prisma.team.findUnique({
      where: { id },
      select: { id: true, suspendedAt: true },
    });
    if (!team) throw new NotFoundException('Team not found');

    if (dto.action === 'note' || dto.action === 'warn') {
      return this.recordModerationEvent(
        actor.userId,
        'team',
        id,
        dto.action === 'warn' ? 'team_warned' : 'team_note_added',
        reason,
      );
    }
    if (dto.action === 'suspend' || dto.action === 'unsuspend') {
      const suspended = dto.action === 'suspend';
      if (Boolean(team.suspendedAt) === suspended) {
        throw new ConflictException(
          suspended ? 'Team is already suspended' : 'Team is not suspended',
        );
      }
      return this.prisma.$transaction(async (tx) => {
        const changed = await tx.team.updateMany({
          where: {
            id,
            suspendedAt: suspended ? null : { not: null },
          },
          data: suspended
            ? { suspendedAt: new Date(), suspensionReason: reason }
            : { suspendedAt: null, suspensionReason: null },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Team moderation state changed; refresh and retry');
        }
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: suspended ? 'team_suspended' : 'team_unsuspended',
            targetType: 'team',
            targetId: id,
            reason,
          },
        });
        return tx.team.findUnique({
          where: { id },
          select: { id: true, suspendedAt: true, suspensionReason: true },
        });
      });
    }
    if (dto.action === 'remove_member') {
      if (!dto.memberId) throw new BadRequestException('A team member is required');
      const member = await this.prisma.teamMember.findFirst({
        where: { id: dto.memberId, teamId: id },
        select: { id: true, userId: true, role: true },
      });
      if (!member) throw new NotFoundException('Team member not found');
      if (member.role === 'owner') {
        throw new ConflictException('The team owner cannot be removed');
      }
      await this.prisma.$transaction(async (tx) => {
        const removed = await tx.teamMember.deleteMany({
          where: { id: member.id, teamId: id, role: { not: 'owner' } },
        });
        if (removed.count !== 1) {
          throw new ConflictException('Team membership changed; refresh and retry');
        }
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: 'team_member_removed',
            targetType: 'team',
            targetId: id,
            reason,
            metadata: { memberId: member.id, userId: member.userId },
          },
        });
      });
      return { removed: true };
    }
    if (dto.action === 'delete') {
      await this.prisma.$transaction(async (tx) => {
        const deleted = await tx.team.deleteMany({ where: { id } });
        if (deleted.count !== 1) throw new NotFoundException('Team not found');
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: 'team_deleted',
            targetType: 'team',
            targetId: id,
            reason,
          },
        });
      });
      return { deleted: true };
    }
    throw new BadRequestException('Unsupported team moderation action');
  }

  private async requireModeratableUser(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, adminUser: { select: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.adminUser) {
      throw new BadRequestException('Staff accounts cannot be moderated here');
    }
    return user;
  }

  private recordModerationEvent(
    actorId: string,
    targetType: 'user' | 'team',
    targetId: string,
    action: string,
    reason: string,
  ) {
    return this.prisma.adminAuditLog.create({
      data: { actorId, action, targetType, targetId, reason },
      select: { id: true, action: true, reason: true, createdAt: true },
    });
  }

  async listReports(status?: string) {
    let reportStatus: AbuseStatus | undefined;
    if (status !== undefined) {
      if (!isAbuseStatus(status)) {
        throw new BadRequestException('Unsupported abuse report status');
      }
      reportStatus = status;
    }
    const reports = await this.prisma.abuseReport.findMany({
      where: reportStatus ? { status: reportStatus } : undefined,
      select: reportSummarySelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    const now = Date.now();
    return reports.map((report) => ({
      ...report,
      ageHours: Math.max(
        0,
        Math.floor((now - report.createdAt.getTime()) / 3_600_000),
      ),
    }));
  }

  async getReport(id: string) {
    const report = await this.prisma.abuseReport.findUnique({
      where: { id },
      select: reportSummarySelect,
    });
    if (!report) throw new NotFoundException('Abuse report not found');
    return report;
  }

  async updateReport(
    id: string,
    dto: UpdateAbuseReportDto,
    actor: AuthenticatedUser,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 10) {
      throw new BadRequestException('Reason must be at least 10 characters');
    }
    if (
      dto.status === undefined
      && dto.severity === undefined
      && dto.assigneeId === undefined
      && dto.resolutionNote === undefined
    ) {
      throw new BadRequestException('At least one report update is required');
    }
    if (
      (dto.status === 'resolved' || dto.status === 'dismissed') &&
      !dto.resolutionNote?.trim()
    ) {
      throw new BadRequestException(
        'A resolution note is required to close an abuse report',
      );
    }

    const existing = await this.prisma.abuseReport.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Abuse report not found');

    if (dto.assigneeId) {
      const assignee = await this.prisma.adminUser.findFirst({
        where: {
          userId: dto.assigneeId,
          role: { in: ['TS', 'ADM'] },
          user: { suspendedAt: null, deletedAt: null },
        },
        select: { userId: true },
      });
      if (!assignee) {
        throw new BadRequestException(
          'Assignee must be an active Trust and Safety or Admin staff account',
        );
      }
    }

    if (existing.status === 'resolved' || existing.status === 'dismissed') {
      throw new ConflictException('Closed abuse reports cannot be changed');
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.abuseReport.updateMany({
        where: { id, status: { notIn: ['resolved', 'dismissed'] } },
        data: {
          ...(dto.status === undefined ? {} : { status: dto.status }),
          ...(dto.severity === undefined ? {} : { severity: dto.severity }),
          ...(dto.assigneeId === undefined
            ? {}
            : { assigneeId: dto.assigneeId }),
          ...(dto.resolutionNote === undefined
            ? {}
            : { resolutionNote: dto.resolutionNote.trim() }),
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException('Abuse report was closed or changed; refresh and retry');
      }
      const report = await transaction.abuseReport.findUnique({
        where: { id },
        select: reportSummarySelect,
      });
      if (!report) throw new NotFoundException('Abuse report not found');
      await transaction.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: 'abuse_report_updated',
          targetType: 'abuse_report',
          targetId: id,
          reason,
          metadata: {
            previousStatus: existing.status,
            status: dto.status ?? existing.status,
            ...(dto.severity === undefined ? {} : { severity: dto.severity }),
            ...(dto.assigneeId === undefined ? {} : { assigneeId: dto.assigneeId }),
          },
        },
      });
      return report;
    });
    return updated;
  }

  listAuditLog() {
    return this.prisma.adminAuditLog.findMany({
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        reason: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, email: true, adminUser: { select: { role: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  async listApprovals() {
    const now = new Date();
    await this.prisma.adminApproval.updateMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return this.prisma.adminApproval.findMany({
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        reason: true,
        details: true,
        status: true,
        expiresAt: true,
        reviewedAt: true,
        createdAt: true,
        requestedBy: { select: { id: true, email: true } },
        reviewedBy: { select: { id: true, email: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async createApproval(dto: CreateAdminApprovalDto, actor: AuthenticatedUser) {
    const reason = dto.reason.trim();
    const detailsJson = JSON.stringify(dto.details);
    if (reason.length < 10 || detailsJson.length > 4000) {
      throw new BadRequestException(
        'Reason must be at least 10 characters and request details must not exceed 4000 characters',
      );
    }
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.adminApproval.create({
        data: {
          action: dto.action.trim(),
          targetType: dto.targetType.trim(),
          targetId: dto.targetId.trim(),
          reason,
          details: JSON.parse(detailsJson) as Prisma.InputJsonValue,
          requestedById: actor.userId,
          expiresAt,
        },
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          reason: true,
          details: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          requestedBy: { select: { id: true, email: true } },
        },
      });
      await transaction.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: 'approval_requested',
          targetType: 'admin_approval',
          targetId: approval.id,
          reason,
          metadata: { action: approval.action, targetType: approval.targetType, targetId: approval.targetId },
        },
      });
      return approval;
    });
  }

  async reviewApproval(
    id: string,
    dto: ReviewAdminApprovalDto,
    actor: AuthenticatedUser,
  ) {
    const reason = dto.reason.trim();
    if (reason.length < 10) {
      throw new BadRequestException('Reason must be at least 10 characters');
    }
    const approval = await this.prisma.adminApproval.findUnique({
      where: { id },
      select: { id: true, status: true, requestedById: true, expiresAt: true },
    });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.requestedById === actor.userId) {
      throw new ConflictException('A staff member cannot review their own request');
    }
    if (approval.status !== 'pending') {
      throw new ConflictException('This approval request has already been reviewed');
    }
    const now = new Date();
    if (approval.expiresAt <= now) {
      await this.prisma.adminApproval.updateMany({
        where: { id, status: 'pending', expiresAt: { lte: now } },
        data: { status: 'expired' },
      });
      throw new ConflictException('This approval request has expired');
    }

    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.adminApproval.updateMany({
        where: { id, status: 'pending', expiresAt: { gt: now } },
        data: {
          status: dto.decision,
          reviewedById: actor.userId,
          reviewedAt: now,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException('Approval request changed; refresh and retry');
      }
      const updated = await transaction.adminApproval.findUnique({
        where: { id },
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          reason: true,
          details: true,
          status: true,
          expiresAt: true,
          reviewedAt: true,
          createdAt: true,
          requestedBy: { select: { id: true, email: true } },
          reviewedBy: { select: { id: true, email: true } },
        },
      });
      if (!updated) throw new NotFoundException('Approval request not found');
      await transaction.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: `approval_${dto.decision}`,
          targetType: 'admin_approval',
          targetId: id,
          reason,
          metadata: { requestedById: approval.requestedById },
        },
      });
      return updated;
    });
  }
}
