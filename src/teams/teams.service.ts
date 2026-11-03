import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import {
  cursorPage,
  cursorPaginationArgs,
} from '../common/dto/cursor-pagination.dto.js';

const MAX_TEAM_MEMBERS = 200;

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
      select: { id: true, userId: true, role: true },
    });
    if (!member) throw new NotFoundException('Team member not found');
    if (member.role === 'owner') {
      throw new ConflictException('The team owner cannot be removed');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.teamSecretKey.deleteMany({
        where: { userId: member.userId, secret: { teamId } },
      });
      await tx.teamMember.delete({ where: { id: member.id } });
    });
  }

  async getEncryptionKey(userId: string) {
    return this.prisma.userEncryptionKey.findUnique({
      where: { userId },
      select: { publicKey: true, encryptedPrivateKey: true, createdAt: true },
    });
  }

  async registerEncryptionKey(
    userId: string,
    publicKey: unknown,
    encryptedPrivateKey: unknown,
  ) {
    validatePublicKey(publicKey);
    validateRecoveryBackup(encryptedPrivateKey);
    const existing = await this.prisma.userEncryptionKey.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (existing) {
      throw new ConflictException(
        'An encryption key is already registered for this account',
      );
    }
    return this.prisma.userEncryptionKey.create({
      data: {
        userId,
        publicKey: publicKey as Prisma.InputJsonValue,
        encryptedPrivateKey: encryptedPrivateKey as Prisma.InputJsonValue,
      },
      select: { publicKey: true, encryptedPrivateKey: true, createdAt: true },
    });
  }

  async listMemberEncryptionKeys(userId: string, teamId: string) {
    await this.requireMember(userId, teamId);
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: {
        userId: true,
        role: true,
        user: {
          select: {
            email: true,
            encryptionKey: { select: { publicKey: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((member) => ({
      userId: member.userId,
      role: member.role,
      email: member.user.email,
      publicKey: member.user.encryptionKey?.publicKey ?? null,
    }));
  }

  async createTeamSecret(
    userId: string,
    teamId: string,
    dto: {
      ciphertext: string;
      iv: string;
      kdf: {
        algorithm: string;
        salt?: string;
        parameters?: Record<string, number>;
      };
      auth?: string;
      label?: string;
      recipient_email?: string;
      max_views?: number;
      expires_in: number;
      teamKeys: Array<{ userId: string; envelope: unknown }>;
    },
  ) {
    const actor = await this.requireMember(userId, teamId);
    if (!actor) throw new NotFoundException('Team not found');
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: {
        creator: { select: { plan: true } },
        members: {
          select: {
            userId: true,
            user: { select: { encryptionKey: { select: { userId: true } } } },
          },
        },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    if (team.creator.plan !== 'team') {
      throw new ForbiddenException(
        'The team owner must have an active Team plan',
      );
    }
    if (dto.recipient_email?.trim()) {
      throw new BadRequestException(
        'Team secrets do not support recipient email verification',
      );
    }
    const ciphertext = dto.ciphertext?.trim();
    const iv = dto.iv?.trim();
    const ciphertextBytes = decodeBase64Url(ciphertext, 'ciphertext');
    if (ciphertextBytes.length > 256 * 1024 + 20) {
      throw new BadRequestException(
        'Ciphertext exceeds the Team plan size limit',
      );
    }
    if (decodeBase64Url(iv, 'iv').length !== 12) {
      throw new BadRequestException('iv must encode exactly 12 random bytes');
    }
    if (
      !Number.isInteger(dto.expires_in) ||
      dto.expires_in < 60 ||
      dto.expires_in > 30 * 86400
    ) {
      throw new BadRequestException(
        'expires_in must be between 60 seconds and 30 days',
      );
    }
    const maxViews = dto.max_views ?? 100;
    if (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > 100) {
      throw new BadRequestException('max_views must be between 1 and 100');
    }
    const kdf = validateSecretKdf(dto.kdf, dto.auth);
    const authHash = dto.auth ? this.hashSecretAuth(dto.auth) : null;
    if (team.members.some((member) => member.user.encryptionKey === null)) {
      throw new ConflictException(
        'Every team member must set up an encryption key before creating a team secret',
      );
    }
    if (!Array.isArray(dto.teamKeys)) {
      throw new BadRequestException('Team key envelopes are required');
    }
    const memberIds = new Set(team.members.map((member) => member.userId));
    if (
      dto.teamKeys.length !== memberIds.size ||
      new Set(dto.teamKeys.map((key) => key.userId)).size !== memberIds.size ||
      dto.teamKeys.some((key) => !memberIds.has(key.userId))
    ) {
      throw new BadRequestException(
        'Encrypted key envelopes must be supplied for every current team member',
      );
    }
    for (const key of dto.teamKeys) validateEnvelope(key.envelope);
    const id = generatePublicId();
    const secret = await this.prisma.$transaction(async (tx) => {
      const created = await tx.secret.create({
        data: {
          id,
          ownerId: null,
          teamId,
          ciphertext,
          ciphertextRef: null,
          iv,
          wrappedKey: null,
          salt: null,
          kdf,
          authHash,
          label: dto.label?.trim().slice(0, 200) || null,
          maxViews,
          expiresAt: new Date(Date.now() + dto.expires_in * 1000),
          recipientEmail: null,
          recipientEmailHash: null,
          teamKeys: {
            create: dto.teamKeys.map((key) => ({
              userId: key.userId,
              envelope: key.envelope as Prisma.InputJsonValue,
            })),
          },
        },
        select: {
          id: true,
          label: true,
          status: true,
          maxViews: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      await tx.auditEvent.create({
        data: { eventType: 'secret_created', secretId: id, actorId: userId },
      });
      return created;
    });
    return secret;
  }

  async listTeamSecrets(userId: string, teamId: string) {
    await this.requireMember(userId, teamId);
    const rows = await this.prisma.secret.findMany({
      where: { teamId },
      select: {
        id: true,
        label: true,
        status: true,
        maxViews: true,
        viewsUsed: true,
        expiresAt: true,
        createdAt: true,
        authHash: true,
        teamKeys: { select: { userId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(({ authHash, teamKeys, ...secret }) => {
      const expired =
        secret.expiresAt !== null && secret.expiresAt <= new Date();
      return {
        ...secret,
        status:
          expired && ['active', 'partially_viewed'].includes(secret.status)
            ? 'expired'
            : secret.status,
        hasPassphrase: Boolean(authHash),
        hasKey: teamKeys.some((key) => key.userId === userId),
        keyRecipients: teamKeys.map((key) => key.userId),
      };
    });
  }

  async revealTeamSecret(userId: string, teamId: string, secretId: string) {
    await this.requireMember(userId, teamId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.prisma.$transaction(async (tx) => {
        const [secret, key] = await Promise.all([
          tx.secret.findFirst({
            where: { id: secretId, teamId },
            select: {
              id: true,
              ciphertext: true,
              iv: true,
              kdf: true,
              status: true,
              expiresAt: true,
              maxViews: true,
              viewsUsed: true,
            },
          }),
          tx.teamSecretKey.findUnique({
            where: { secretId_userId: { secretId, userId } },
            select: { envelope: true },
          }),
        ]);
        if (!secret || !key)
          throw new NotFoundException('Team secret not found');
        if (
          !['active', 'partially_viewed'].includes(secret.status) ||
          (secret.expiresAt !== null && secret.expiresAt <= new Date()) ||
          (secret.maxViews !== null && secret.viewsUsed >= secret.maxViews)
        ) {
          throw new ConflictException(
            'This team secret is no longer available',
          );
        }

        const nextViews = secret.viewsUsed + 1;
        const updated = await tx.secret.updateMany({
          where: {
            id: secretId,
            teamId,
            status: secret.status,
            viewsUsed: secret.viewsUsed,
          },
          data: {
            viewsUsed: nextViews,
            status:
              secret.maxViews !== null && nextViews >= secret.maxViews
                ? 'viewed'
                : 'partially_viewed',
          },
        });
        if (updated.count !== 1) return null;
        await tx.auditEvent.create({
          data: { eventType: 'secret_viewed', secretId, actorId: userId },
        });
        return { ...secret, viewsUsed: nextViews, envelope: key.envelope };
      });
      if (result) {
        if (!result.ciphertext) {
          throw new ConflictException(
            'Encrypted team secret content is unavailable',
          );
        }
        return result;
      }
    }
    throw new ConflictException(
      'Team secret changed while opening it. Try again.',
    );
  }

  async getTeamSecretKey(userId: string, teamId: string, secretId: string) {
    await this.requireMember(userId, teamId);
    const key = await this.prisma.teamSecretKey.findFirst({
      where: { secretId, userId, secret: { teamId } },
      select: { envelope: true },
    });
    if (!key) throw new NotFoundException('Team secret key not found');
    return key;
  }

  async shareTeamSecretKey(
    userId: string,
    teamId: string,
    secretId: string,
    targetUserId: string,
    envelope: unknown,
  ) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can share older secrets',
      );
    }
    validateEnvelope(envelope);
    const [secret, member] = await Promise.all([
      this.prisma.secret.findFirst({
        where: { id: secretId, teamId },
        select: { id: true, status: true, expiresAt: true },
      }),
      this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        select: {
          user: { select: { encryptionKey: { select: { userId: true } } } },
        },
      }),
    ]);
    if (!secret || !member)
      throw new NotFoundException('Team secret or member not found');
    if (
      !['active', 'partially_viewed'].includes(secret.status) ||
      (secret.expiresAt !== null && secret.expiresAt <= new Date())
    ) {
      throw new ConflictException(
        'Only available team secrets can be re-shared',
      );
    }
    if (!member.user.encryptionKey) {
      throw new ConflictException(
        'The member must set up an encryption key first',
      );
    }
    return this.prisma.teamSecretKey.upsert({
      where: { secretId_userId: { secretId, userId: targetUserId } },
      create: {
        secretId,
        userId: targetUserId,
        envelope: envelope as Prisma.InputJsonValue,
      },
      update: { envelope: envelope as Prisma.InputJsonValue },
      select: { secretId: true, userId: true, createdAt: true },
    });
  }

  async revokeTeamSecret(userId: string, teamId: string, secretId: string) {
    const actor = await this.requireMember(userId, teamId);
    if (!['owner', 'admin'].includes(actor.role)) {
      throw new ForbiddenException(
        'Only team owners and admins can revoke team secrets',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.secret.updateMany({
        where: { id: secretId, teamId, status: { not: 'revoked' } },
        data: { status: 'revoked', ciphertext: null },
      });
      if (!updated.count) throw new NotFoundException('Team secret not found');
      await tx.teamSecretKey.deleteMany({ where: { secretId } });
      await tx.auditEvent.create({
        data: { eventType: 'secret_revoked', secretId, actorId: userId },
      });
    });
  }

  private hashSecretAuth(auth: string) {
    const pepper = this.config.get<string>('SECRET_AUTH_PEPPER');
    if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new ConflictException(
        'Secret passphrase verification is unavailable',
      );
    }
    const authBytes = decodeBase64Url(auth, 'auth');
    if (authBytes.length !== 32) {
      throw new BadRequestException('auth must encode exactly 32 random bytes');
    }
    return createHmac('sha256', pepper).update(authBytes).digest('hex');
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
    const [memberCount, pendingInvitationCount] = await Promise.all([
      this.prisma.teamMember.count({ where: { teamId } }),
      this.prisma.teamInvitation.count({
        where: {
          teamId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);
    if (memberCount + pendingInvitationCount >= MAX_TEAM_MEMBERS) {
      throw new ConflictException(
        `A team can have at most ${MAX_TEAM_MEMBERS} members`,
      );
    }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJsonSize(value: unknown, field: string, maximumBytes: number) {
  if (!isRecord(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) {
    throw new BadRequestException(`${field} is too large`);
  }
  return value;
}

function validatePublicKey(value: unknown) {
  const key = validateJsonSize(value, 'publicKey', 4096);
  if (
    Object.hasOwn(key, 'd') ||
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !isBase64Url(key.x) ||
    !isBase64Url(key.y) ||
    decodeBase64Url(key.x, 'publicKey.x').length !== 32 ||
    decodeBase64Url(key.y, 'publicKey.y').length !== 32
  ) {
    throw new BadRequestException('publicKey must be a P-256 ECDH public key');
  }
}

function validateRecoveryBackup(value: unknown) {
  const backup = validateJsonSize(value, 'encryptedPrivateKey', 12_000);
  if (
    backup.version !== 1 ||
    backup.algorithm !== 'AES-GCM' ||
    typeof backup.salt !== 'string' ||
    typeof backup.iv !== 'string' ||
    typeof backup.ciphertext !== 'string' ||
    !isRecord(backup.kdf) ||
    backup.kdf.algorithm !== 'Argon2id' ||
    backup.kdf.m !== 65536 ||
    backup.kdf.t !== 3 ||
    backup.kdf.p !== 1 ||
    decodeBase64Url(backup.salt, 'encryptedPrivateKey.salt').length !== 16 ||
    decodeBase64Url(backup.iv, 'encryptedPrivateKey.iv').length !== 12
  ) {
    throw new BadRequestException('Encrypted private-key backup is invalid');
  }
  decodeBase64Url(backup.ciphertext, 'encryptedPrivateKey.ciphertext');
}

function validateEnvelope(value: unknown) {
  const envelope = validateJsonSize(value, 'envelope', 8192);
  if (
    envelope.version !== 1 ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    !isRecord(envelope.ephemeralPublicKey) ||
    Object.hasOwn(envelope.ephemeralPublicKey, 'd') ||
    envelope.ephemeralPublicKey.kty !== 'EC' ||
    envelope.ephemeralPublicKey.crv !== 'P-256' ||
    typeof envelope.ephemeralPublicKey.x !== 'string' ||
    typeof envelope.ephemeralPublicKey.y !== 'string' ||
    !isBase64Url(envelope.ephemeralPublicKey.x) ||
    !isBase64Url(envelope.ephemeralPublicKey.y) ||
    decodeBase64Url(envelope.ephemeralPublicKey.x, 'envelope.publicKey.x')
      .length !== 32 ||
    decodeBase64Url(envelope.ephemeralPublicKey.y, 'envelope.publicKey.y')
      .length !== 32 ||
    decodeBase64Url(envelope.salt, 'envelope.salt').length !== 16 ||
    decodeBase64Url(envelope.iv, 'envelope.iv').length !== 12
  ) {
    throw new BadRequestException('Encrypted team key envelope is invalid');
  }
  if (
    decodeBase64Url(envelope.ciphertext, 'envelope.ciphertext').length !== 48
  ) {
    throw new BadRequestException(
      'Team key envelopes must contain one 32-byte key',
    );
  }
}

function validateSecretKdf(
  kdf: {
    algorithm: string;
    salt?: string;
    parameters?: Record<string, number>;
  },
  auth?: string,
): Prisma.InputJsonObject {
  if (kdf.algorithm === 'HKDF-SHA-256' && !auth) {
    return { algorithm: 'HKDF-SHA-256' };
  }
  if (
    kdf.algorithm === 'Argon2id' &&
    auth &&
    kdf.parameters?.m === 65536 &&
    kdf.parameters.t === 3 &&
    kdf.parameters.p === 1 &&
    typeof kdf.salt === 'string' &&
    decodeBase64Url(kdf.salt, 'kdf.salt').length === 16
  ) {
    return {
      algorithm: 'Argon2id',
      salt: kdf.salt,
      parameters: { m: 65536, t: 3, p: 1 },
    };
  }
  throw new BadRequestException('Secret key-derivation parameters are invalid');
}

function isBase64Url(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeBase64Url(value: string, field: string) {
  if (!value || !isBase64Url(value)) {
    throw new BadRequestException(`${field} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new BadRequestException(`${field} must be valid unpadded base64url`);
  }
  return decoded;
}

function generatePublicId() {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return Array.from(
    { length: 22 },
    () => alphabet[randomInt(alphabet.length)],
  ).join('');
}
