import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import {
  cursorPage,
  cursorPaginationArgs,
} from '../common/dto/cursor-pagination.dto.js';

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailDeliveryService,
  ) {}

  async create(userId: string, name: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.plan !== 'team') {
      throw new ForbiddenException('Teams require a Team plan');
    }
    const teamName = name?.trim();
    if (!teamName || teamName.length > 100) {
      throw new ConflictException(
        'A team name between 1 and 100 characters is required',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name: teamName,
          createdBy: userId,
          members: { create: { userId, role: 'owner' } },
        },
        select: { id: true, name: true, createdBy: true, createdAt: true },
      });
      return team;
    });
  }

  async listForUser(userId: string, cursor?: string, limit = 50) {
    const rows = await this.prisma.team.findMany({
      where: { suspendedAt: null, members: { some: { userId } } },
      select: {
        id: true,
        name: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        suspendedAt: true,
        members: {
          where: { userId },
          select: { role: true },
        },
        _count: { select: { members: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async getForUser(userId: string, teamId: string) {
    await this.requireMember(userId, teamId);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        suspendedAt: true,
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, emailVerifiedAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  async updateName(userId: string, teamId: string, name: string) {
    const membership = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can update a team',
      );
    }
    const teamName = name?.trim();
    if (!teamName || teamName.length > 100) {
      throw new ConflictException(
        'A team name between 1 and 100 characters is required',
      );
    }
    return this.prisma.team.update({
      where: { id: teamId },
      data: { name: teamName },
      select: { id: true, name: true, updatedAt: true },
    });
  }

  async updateMemberRole(
    userId: string,
    teamId: string,
    memberId: string,
    role: 'admin' | 'member',
  ) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can manage members',
      );
    }
    const member = await this.prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      select: { id: true, userId: true, role: true },
    });
    if (!member) throw new NotFoundException('Team member not found');
    if (
      member.role === 'owner' ||
      (role === 'admin' && actor.role !== 'owner')
    ) {
      throw new ForbiddenException(
        'Only the owner can manage administrator roles',
      );
    }
    return this.prisma.teamMember.update({
      where: { id: member.id },
      data: { role },
      select: { id: true, userId: true, role: true },
    });
  }

  async removeMember(userId: string, teamId: string, memberId: string) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can remove members',
      );
    }
    const member = await this.prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      select: { id: true, role: true },
    });
    if (!member) throw new NotFoundException('Team member not found');
    if (member.role === 'owner') {
      throw new ConflictException('The team owner cannot be removed');
    }
    await this.prisma.teamMember.delete({ where: { id: member.id } });
  }

  async inviteMember(
    userId: string,
    teamId: string,
    email: string,
    role: 'admin' | 'member' = 'member',
  ) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can invite members',
      );
    }
    if (role === 'admin' && actor.role !== 'owner') {
      throw new ForbiddenException('Only the owner can invite administrators');
    }
    const normalizedEmail = email?.trim().toLowerCase();
    if (
      !normalizedEmail ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      throw new ConflictException('A valid email address is required');
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existingUser) {
      const existingMember = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: existingUser.id } },
      });
      if (existingMember)
        throw new ConflictException('User is already a team member');
    }
    const pending = await this.prisma.teamInvitation.findFirst({
      where: {
        teamId,
        email: normalizedEmail,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (pending)
      throw new ConflictException('An active invitation already exists');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await this.prisma.teamInvitation.create({
      data: {
        teamId,
        inviterId: userId,
        email: normalizedEmail,
        tokenHash,
        role,
        expiresAt,
      },
      select: { id: true },
    });
    try {
      const baseUrl = (this.config.get<string>('FRONTEND_URL') ?? '')
        .split(',')[0]
        .trim();
      if (!baseUrl)
        throw new ConflictException('FRONTEND_URL is not configured');
      await this.email.sendTeamInvitation(
        normalizedEmail,
        team.name,
        `${baseUrl}/team-invitations/accept?token=${encodeURIComponent(token)}`,
        expiresAt,
      );
    } catch (error) {
      await this.prisma.teamInvitation.delete({ where: { id: invitation.id } });
      throw error;
    }
    return { id: invitation.id, email: normalizedEmail, role, expiresAt };
  }

  listInvitations(userId: string, teamId: string) {
    return this.requireMember(userId, teamId).then((member) => {
      if (!['owner', 'admin'].includes(member.role)) {
        throw new ForbiddenException(
          'Only team owners and admins can view invitations',
        );
      }
      return this.prisma.teamInvitation.findMany({
        where: { teamId },
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
      });
    });
  }

  async revokeInvitation(userId: string, teamId: string, invitationId: string) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can revoke invitations',
      );
    }
    const updated = await this.prisma.teamInvitation.updateMany({
      where: { id: invitationId, teamId, revokedAt: null, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new NotFoundException('Invitation not found');
  }

  async acceptInvitation(userId: string, token: string) {
    const normalizedToken = token?.trim();
    if (!normalizedToken)
      throw new ConflictException('Invitation token is required');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const invitation = await this.prisma.teamInvitation.findUnique({
      where: { tokenHash: hashToken(normalizedToken) },
      select: {
        id: true,
        teamId: true,
        email: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });
    const team = invitation
      ? await this.prisma.team.findUnique({
          where: { id: invitation.teamId },
          select: { suspendedAt: true },
        })
      : null;
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      !team ||
      team.suspendedAt
    ) {
      throw new ConflictException('Invitation is invalid or expired');
    }
    if (user.email.toLowerCase() !== invitation.email) {
      throw new ForbiddenException(
        'Invitation email does not match the authenticated user',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: invitation.teamId, userId } },
        update: { role: invitation.role },
        create: { teamId: invitation.teamId, userId, role: invitation.role },
      });
      await tx.teamInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
    });
    return { teamId: invitation.teamId, role: invitation.role };
  }

  async listPolicies(userId: string, teamId: string) {
    await this.requireMember(userId, teamId);
    return this.prisma.policy.findMany({
      where: { teamId },
      select: {
        id: true,
        policyType: true,
        rules: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async upsertPolicy(
    userId: string,
    teamId: string,
    policyType:
      | 'secret_expiration'
      | 'access_control'
      | 'view_limit'
      | 'team_security'
      | 'retention'
      | 'custom',
    rules: Record<string, unknown>,
  ) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can manage policies',
      );
    }
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      throw new ConflictException('rules must be an object');
    }
    const jsonRules = JSON.parse(
      JSON.stringify(rules),
    ) as Prisma.InputJsonValue;
    const existing = await this.prisma.policy.findFirst({
      where: { teamId, policyType },
      select: { id: true },
    });
    if (existing) {
      return this.prisma.policy.update({
        where: { id: existing.id },
        data: { rules: jsonRules },
        select: { id: true, policyType: true, rules: true, updatedAt: true },
      });
    }
    return this.prisma.policy.create({
      data: { teamId, policyType, rules: jsonRules },
      select: { id: true, policyType: true, rules: true, updatedAt: true },
    });
  }

  private async requireMember(userId: string, teamId: string) {
    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { role: true, team: { select: { suspendedAt: true } } },
    });
    if (!membership) throw new NotFoundException('Team not found');
    if (membership.team.suspendedAt) {
      throw new ForbiddenException('This team is suspended');
    }
    return membership;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
