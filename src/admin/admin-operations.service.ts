import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InvoiceStatus,
  Prisma,
  SubscriptionStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import type {
  CreateAdminBlocklistEntryDto,
  CreateAdminDataRequestDto,
  UpdateAdminDataRequestDto,
} from './admin-operations.dto.js';

@Injectable()
export class AdminOperationsService {
  constructor(private readonly prisma: PrismaService) {}

  listTeams() {
    return this.prisma.team.findMany({
      select: {
        id: true,
        name: true,
        createdAt: true,
        suspendedAt: true,
        suspensionReason: true,
        creator: { select: { id: true, email: true } },
        _count: { select: { members: true, invitations: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getTeam(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        createdAt: true,
        suspendedAt: true,
        suspensionReason: true,
        creator: { select: { id: true, email: true } },
        members: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, suspendedAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        invitations: {
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            acceptedAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        policies: {
          select: { id: true, policyType: true, rules: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    const memberIds = team.members.map((member) => member.user.id);
    const [moderationHistory, abuseReports] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where: { targetType: 'team', targetId: id },
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
      memberIds.length === 0
        ? Promise.resolve([])
        : this.prisma.abuseReport.findMany({
            where: {
              OR: [
                { reporterId: { in: memberIds } },
                { secret: { ownerId: { in: memberIds } } },
              ],
            },
            select: {
              id: true,
              reason: true,
              status: true,
              severity: true,
              createdAt: true,
              reporter: { select: { id: true, email: true } },
              secret: {
                select: {
                  id: true,
                  status: true,
                  owner: { select: { id: true, email: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          }),
    ]);
    return { ...team, moderationHistory, abuseReports };
  }

  listSubscriptions(status?: string) {
    if (status !== undefined && !Object.values(SubscriptionStatus).includes(status as SubscriptionStatus)) {
      throw new BadRequestException('Unsupported subscription status');
    }
    return this.prisma.subscription.findMany({
      where: status ? { status: status as SubscriptionStatus } : undefined,
      select: {
        id: true,
        planId: true,
        tier: true,
        billingInterval: true,
        currency: true,
        status: true,
        cancelAtPeriodEnd: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  listInvoices(status?: string) {
    if (status !== undefined && !Object.values(InvoiceStatus).includes(status as InvoiceStatus)) {
      throw new BadRequestException('Unsupported invoice status');
    }
    return this.prisma.invoice.findMany({
      where: status ? { status: status as InvoiceStatus } : undefined,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        issuedAt: true,
        paidAt: true,
        paymentId: true,
        externalId: true,
        user: { select: { id: true, email: true } },
        subscription: { select: { id: true, tier: true, status: true } },
      },
      orderBy: { issuedAt: 'desc' },
      take: 100,
    });
  }

  listRefunds() {
    return this.prisma.billingRefund.findMany({
      select: {
        id: true,
        externalId: true,
        paymentId: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getSecretMetadata(id: string) {
    const secret = await this.prisma.secret.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        maxViews: true,
        viewsUsed: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        owner: { select: { id: true, email: true } },
        _count: { select: { abuseReports: true } },
      },
    });
    if (!secret) throw new NotFoundException('Secret not found');
    return secret;
  }

  listDataRequests() {
    return this.prisma.adminDataRequest.findMany({
      select: {
        id: true,
        kind: true,
        status: true,
        reason: true,
        staffNote: true,
        dueAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, email: true } },
        createdBy: { select: { id: true, email: true } },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    });
  }

  async createDataRequest(
    dto: CreateAdminDataRequestDto,
    actor: AuthenticatedUser,
  ) {
    const dueAt = new Date(dto.dueAt);
    if (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date()) {
      throw new BadRequestException('dueAt must be a future date');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.adminDataRequest.create({
        data: {
          userId: dto.userId,
          kind: dto.kind,
          reason: dto.reason.trim(),
          dueAt,
          createdById: actor.userId,
        },
        select: { id: true, kind: true, status: true, dueAt: true },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: 'data_request_created',
          targetType: 'data_request',
          targetId: request.id,
          reason: dto.reason.trim(),
          metadata: { kind: dto.kind, userId: dto.userId },
        },
      });
      return request;
    });
  }

  async updateDataRequest(
    id: string,
    dto: UpdateAdminDataRequestDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.prisma.adminDataRequest.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!current) throw new NotFoundException('Data request not found');
    if (current.status === 'completed' || current.status === 'rejected') {
      throw new ConflictException('Closed data requests cannot be changed');
    }
    const nextStatuses: Record<string, readonly string[]> = {
      received: ['verifying', 'rejected'],
      verifying: ['processing', 'rejected'],
      processing: ['completed', 'rejected'],
    };
    if (!nextStatuses[current.status]?.includes(dto.status)) {
      throw new ConflictException('Data request status transition is not allowed');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.adminDataRequest.update({
        where: { id },
        data: {
          status: dto.status,
          staffNote: dto.staffNote?.trim() || null,
        },
        select: { id: true, status: true, staffNote: true, updatedAt: true },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: 'data_request_updated',
          targetType: 'data_request',
          targetId: id,
          reason: dto.reason.trim(),
          metadata: { from: current.status, to: dto.status },
        },
      });
      return updated;
    });
  }

  listBlocklist() {
    return this.prisma.adminBlocklistEntry.findMany({
      select: {
        id: true,
        kind: true,
        value: true,
        reason: true,
        expiresAt: true,
        createdAt: true,
        createdBy: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async createBlocklistEntry(
    dto: CreateAdminBlocklistEntryDto,
    actor: AuthenticatedUser,
  ) {
    const value = normalizeBlocklistValue(dto.kind, dto.value);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
      throw new BadRequestException('expiresAt must be a future date');
    }
    if (dto.kind === 'account') {
      const user = await this.prisma.user.findUnique({
        where: { id: value },
        select: { id: true, adminUser: { select: { role: true } } },
      });
      if (!user) throw new NotFoundException('User not found');
      if (user.adminUser?.role === 'ADM') {
        throw new BadRequestException('An Admin account cannot be blocklisted');
      }
    } else {
      const adminOnDomain = await this.prisma.user.findFirst({
        where: {
          email: { endsWith: `@${value}`, mode: 'insensitive' },
          adminUser: { role: 'ADM' },
        },
        select: { id: true },
      });
      if (adminOnDomain) {
        throw new BadRequestException('A domain containing an Admin account cannot be blocklisted');
      }
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const entry = await tx.adminBlocklistEntry.create({
          data: {
            kind: dto.kind,
            value,
            reason: dto.reason.trim(),
            expiresAt,
            createdById: actor.userId,
          },
          select: { id: true, kind: true, value: true, expiresAt: true },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.userId,
            action: 'blocklist_entry_created',
            targetType: 'blocklist_entry',
            targetId: entry.id,
            reason: dto.reason.trim(),
            metadata: { kind: dto.kind, value },
          },
        });
        return entry;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
      ) {
        throw new ConflictException('This blocklist entry already exists');
      }
      throw error;
    }
  }

  async deleteBlocklistEntry(
    id: string,
    reason: string,
    actor: AuthenticatedUser,
  ) {
    const entry = await this.prisma.adminBlocklistEntry.findUnique({
      where: { id },
      select: { id: true, kind: true, value: true },
    });
    if (!entry) throw new NotFoundException('Blocklist entry not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.adminBlocklistEntry.delete({ where: { id } });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.userId,
          action: 'blocklist_entry_deleted',
          targetType: 'blocklist_entry',
          targetId: id,
          reason: reason.trim(),
          metadata: { kind: entry.kind, value: entry.value },
        },
      });
    });
    return { ok: true };
  }
}

function normalizeBlocklistValue(
  kind: CreateAdminBlocklistEntryDto['kind'],
  value: string,
) {
  const normalized = value.trim().toLowerCase();
  if (kind === 'account') {
    if (normalized.length < 1 || normalized.length > 128) {
      throw new BadRequestException('Account ID is invalid');
    }
    return value.trim();
  }
  const domain = normalized.replace(/^\.+|\.+$/g, '');
  if (
    domain.length > 253
    || !domain.includes('.')
    || domain.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
  ) {
    throw new BadRequestException('A valid email domain is required');
  }
  return domain;
}
