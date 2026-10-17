import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { StoragePurgeService } from '../storage/storage-purge.service.js';
import {
  cursorPage,
  cursorPaginationArgs,
} from '../common/dto/cursor-pagination.dto.js';
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
} from '../common/auth/api-key-scopes.js';
import {
  NOTIFICATION_TYPES,
  normalizeNotificationPreferences,
  type NotificationPreferences,
} from '../common/notifications/notification-preferences.js';
import type { NotificationPreferencesDto } from './dto/notification-preferences.dto.js';
import type { Prisma } from '../generated/prisma/client.js';
import { BillingService } from '../billing/billing.service.js';

const planEntitlements = {
  free: {
    maxTextBytes: 64 * 1024,
    maxViews: 10,
    historyDays: 30,
    files: false,
    api: false,
    audit: false,
    teams: false,
  },
  pro: {
    maxTextBytes: 256 * 1024,
    maxViews: 100,
    historyDays: 365,
    files: true,
    api: true,
    audit: true,
    teams: false,
  },
  team: {
    maxTextBytes: 256 * 1024,
    maxViews: 100,
    historyDays: 730,
    files: true,
    api: true,
    audit: true,
    teams: true,
  },
} as const;

const secretSummary = {
  id: true,
  label: true,
  status: true,
  maxViews: true,
  viewsUsed: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storagePurge: StoragePurgeService,
    private readonly config: ConfigService,
    private readonly billing: BillingService,
  ) {}

  async entitlements(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { plan: user.plan, limits: planEntitlements[user.plan] };
  }

  async stats(userId: string) {
    const [total, active, viewed, revoked] = await Promise.all([
      this.prisma.secret.count({ where: { ownerId: userId } }),
      this.prisma.secret.count({
        where: { ownerId: userId, status: 'active' },
      }),
      this.prisma.secret.count({
        where: { ownerId: userId, status: 'viewed' },
      }),
      this.prisma.secret.count({
        where: { ownerId: userId, status: 'revoked' },
      }),
    ]);
    return { total, active, viewed, revoked };
  }

  async listSecrets(userId: string, cursor?: string, limit = 50) {
    const rows = await this.prisma.secret.findMany({
      where: { ownerId: userId },
      select: secretSummary,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async getSecret(userId: string, secretId: string) {
    const secret = await this.prisma.secret.findFirst({
      where: { id: secretId, ownerId: userId },
      select: secretSummary,
    });
    if (!secret) {
      throw new NotFoundException('Secret not found');
    }
    return secret;
  }

  async getSecretEvents(
    userId: string,
    secretId: string,
    cursor?: string,
    limit = 50,
  ) {
    await this.getSecret(userId, secretId);
    const entitlements = await this.entitlements(userId);
    const retentionCutoff = new Date(
      Date.now() - entitlements.limits.historyDays * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.auditEvent.findMany({
      where: { secretId, timestamp: { gte: retentionCutoff } },
      select: {
        id: true,
        eventType: true,
        actorId: true,
        ipRegion: true,
        device: true,
        timestamp: true,
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async deleteTerminalSecret(userId: string, secretId: string): Promise<void> {
    const secret = await this.prisma.secret.findFirst({
      where: { id: secretId, ownerId: userId },
      select: { id: true, status: true },
    });
    if (!secret) {
      throw new NotFoundException('Secret not found');
    }
    if (!['viewed', 'expired', 'revoked'].includes(secret.status)) {
      throw new ConflictException('Only terminal secrets can be deleted');
    }
    const storage = await this.prisma.secret.findUnique({
      where: { id: secret.id },
      select: { ciphertextRef: true, files: { select: { storageRef: true } } },
    });
    await this.prisma.secret.delete({ where: { id: secret.id } });
    if (storage) {
      await this.storagePurge.purgeSecret(secret.id, [
        storage.ciphertextRef,
        ...storage.files.map((file) => file.storageRef),
      ]);
    }
  }

  async audit(userId: string, cursor?: string, limit = 50) {
    const entitlements = await this.entitlements(userId);
    if (!entitlements.limits.audit) {
      throw new ForbiddenException('Audit history requires a Pro or Team plan');
    }
    const retentionCutoff = new Date(
      Date.now() - entitlements.limits.historyDays * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.auditEvent.findMany({
      where: { actorId: userId, timestamp: { gte: retentionCutoff } },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async createApiKey(
    userId: string,
    name: string,
    expiresAt?: string,
    scopes?: ApiKeyScope[],
  ) {
    const entitlements = await this.entitlements(userId);
    if (!entitlements.limits.api) {
      throw new ForbiddenException('API keys require a Pro or Team plan');
    }
    const trimmedName = name?.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new ConflictException(
        'A key name between 1 and 100 characters is required',
      );
    }
    const parsedExpiry = expiresAt ? new Date(expiresAt) : null;
    if (expiresAt && (!parsedExpiry || Number.isNaN(parsedExpiry.getTime()))) {
      throw new ConflictException('expiresAt must be a valid ISO date');
    }
    if (parsedExpiry && parsedExpiry <= new Date()) {
      throw new ConflictException('expiresAt must be in the future');
    }
    const selectedScopes = scopes ?? ['secrets:read'];
    if (
      selectedScopes.length === 0 ||
      new Set(selectedScopes).size !== selectedScopes.length ||
      selectedScopes.some(
        (scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope),
      )
    ) {
      throw new ConflictException(
        'scopes must contain unique supported permissions',
      );
    }

    const plaintext = `kd_${randomBytes(32).toString('base64url')}`;
    const key = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          userId,
          name: trimmedName,
          keyHash: hashApiKey(plaintext),
          expiresAt: parsedExpiry,
          scopes: selectedScopes,
        },
        select: {
          id: true,
          name: true,
          scopes: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      await tx.auditEvent.create({
        data: { eventType: 'api_key_created', actorId: userId },
      });
      return created;
    });
    return { ...key, key: plaintext };
  }

  async listApiKeys(userId: string) {
    const entitlements = await this.entitlements(userId);
    if (!entitlements.limits.api) {
      throw new ForbiddenException('API keys require a Pro or Team plan');
    }
    return this.prisma.apiKey.findMany({
      where: { userId },
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
    });
  }

  async revokeApiKey(userId: string, keyId: string) {
    const entitlements = await this.entitlements(userId);
    if (!entitlements.limits.api) {
      throw new ForbiddenException('API keys require a Pro or Team plan');
    }
    const updated = await this.prisma.apiKey.updateMany({
      where: { id: keyId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new NotFoundException('API key not found or already revoked');
    }
    await this.prisma.auditEvent.create({
      data: { eventType: 'api_key_revoked', actorId: userId },
    });
  }

  async listNotifications(userId: string, cursor?: string, limit = 50) {
    const preferences = await this.getNotificationPreferences(userId);
    const enabledTypes = NOTIFICATION_TYPES.filter(
      (type) => preferences[type].inApp,
    );
    const rows = await this.prisma.notification.findMany({
      where: { userId, type: { in: enabledTypes } },
      select: {
        id: true,
        secretId: true,
        type: true,
        payload: true,
        readAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    return cursorPage(rows, limit);
  }

  async getNotificationPreferences(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPreferences: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return normalizeNotificationPreferences(user.notificationPreferences);
  }

  async updateNotificationPreferences(
    userId: string,
    updates: NotificationPreferencesDto,
  ): Promise<NotificationPreferences> {
    const existing = await this.getNotificationPreferences(userId);
    const preferences = { ...existing };
    for (const type of NOTIFICATION_TYPES) {
      const update = updates[type];
      if (update)
        preferences[type] = { inApp: update.inApp, email: update.email };
    }
    const serialized = JSON.parse(
      JSON.stringify(preferences),
    ) as Prisma.InputJsonValue;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPreferences: serialized },
      select: { notificationPreferences: true },
    });
    return normalizeNotificationPreferences(user.notificationPreferences);
  }

  async exportAccount(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        plan: true,
        emailVerifiedAt: true,
        createdAt: true,
        notificationPreferences: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const [
      secrets,
      notifications,
      auditEvents,
      apiKeys,
      subscriptions,
      invoices,
      memberships,
      policies,
      abuseReports,
      sentInvitations,
    ] = await Promise.all([
      this.prisma.secret.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          label: true,
          status: true,
          maxViews: true,
          viewsUsed: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
          ciphertextRef: true,
          iv: true,
          wrappedKey: true,
          salt: true,
          files: {
            select: {
              id: true,
              storageRef: true,
              filename: true,
              contentType: true,
              sizeBytes: true,
              uploadedAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.notification.findMany({
        where: { userId },
        select: {
          id: true,
          secretId: true,
          type: true,
          payload: true,
          readAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.auditEvent.findMany({
        where: { actorId: userId },
        orderBy: { timestamp: 'asc' },
      }),
      this.prisma.apiKey.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.subscription.findMany({
        where: { userId },
        select: {
          id: true,
          planId: true,
          tier: true,
          billingInterval: true,
          currency: true,
          pendingTier: true,
          pendingInterval: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.invoice.findMany({
        where: { userId },
        select: {
          id: true,
          subscriptionId: true,
          amount: true,
          currency: true,
          status: true,
          issuedAt: true,
          paidAt: true,
          externalId: true,
          createdAt: true,
        },
        orderBy: { issuedAt: 'asc' },
      }),
      this.prisma.teamMember.findMany({
        where: { userId },
        select: {
          role: true,
          createdAt: true,
          team: { select: { id: true, name: true, createdAt: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.policy.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          policyType: true,
          rules: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.abuseReport.findMany({
        where: { reporterId: userId },
        select: {
          id: true,
          secretId: true,
          reason: true,
          details: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.teamInvitation.findMany({
        where: { inviterId: userId },
        select: {
          id: true,
          teamId: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const region = this.config.get<string>('S3_REGION');
    const bucket = this.config.get<string>('S3_BUCKET');
    const s3 = region && bucket ? new S3Client({ region }) : undefined;
    const exportNow = new Date();
    const exportedSecrets = await Promise.all(
      secrets.map(async (secret) => ({
        id: secret.id,
        label: secret.label,
        status: secret.status,
        maxViews: secret.maxViews,
        viewsUsed: secret.viewsUsed,
        expiresAt: secret.expiresAt,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        encryption: {
          ciphertextUrl:
            s3 &&
            bucket &&
            secret.status === 'active' &&
            (!secret.expiresAt || secret.expiresAt > exportNow) &&
            (secret.maxViews === null || secret.viewsUsed < secret.maxViews)
              ? await getSignedUrl(
                  s3,
                  new GetObjectCommand({
                    Bucket: bucket,
                    Key: secret.ciphertextRef,
                  }),
                  { expiresIn: 900 },
                )
              : null,
          iv: secret.iv,
          wrappedKey: secret.wrappedKey,
          salt: secret.salt,
        },
        files: await Promise.all(
          secret.files.map(async (file) => ({
            id: file.id,
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes === null ? null : Number(file.sizeBytes),
            uploadedAt: file.uploadedAt,
            createdAt: file.createdAt,
            downloadUrl:
              s3 && bucket && file.uploadedAt
                ? await getSignedUrl(
                    s3,
                    new GetObjectCommand({
                      Bucket: bucket,
                      Key: file.storageRef,
                    }),
                    { expiresIn: 900 },
                  )
                : null,
          })),
        ),
      })),
    );
    return {
      exportedAt: new Date().toISOString(),
      storageDownloadsAvailable: Boolean(s3 && bucket),
      account: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        notificationPreferences: normalizeNotificationPreferences(
          user.notificationPreferences,
        ),
      },
      secrets: exportedSecrets,
      notifications,
      auditEvents,
      apiKeys,
      subscriptions,
      invoices,
      teams: memberships.map((membership) => ({
        ...membership.team,
        role: membership.role,
        joinedAt: membership.createdAt,
      })),
      policies,
      abuseReports,
      sentInvitations,
    };
  }

  async deleteAccount(userId: string, cognitoUsername: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        adminUser: { select: { role: true } },
        secrets: {
          select: {
            id: true,
            ciphertextRef: true,
            files: { select: { storageRef: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.adminUser) {
      throw new ForbiddenException(
        'Staff accounts must be removed by an administrator',
      );
    }
    const userPoolId = this.config.get<string>('USER_COGNITO_USER_POOL_ID');
    const region = this.config.get<string>('COGNITO_REGION');
    if (!userPoolId || !region || !cognitoUsername?.trim()) {
      throw new ServiceUnavailableException(
        'Cognito account deletion is not configured',
      );
    }
    await this.billing.cancelSubscriptionsForAccountDeletion(userId);
    const cognito = new CognitoIdentityProviderClient({ region });
    try {
      await cognito.send(
        new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: cognitoUsername.trim(),
        }),
      );
    } catch (error) {
      if (!isCognitoUserNotFound(error)) {
        throw new ServiceUnavailableException(
          'Unable to delete the Cognito account',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const teams = await tx.team.findMany({
        where: {
          OR: [
            { createdBy: userId },
            { members: { some: { userId, role: 'owner' } } },
          ],
        },
        select: {
          id: true,
          createdBy: true,
          members: {
            select: { userId: true, role: true, createdAt: true },
          },
        },
      });
      for (const team of teams) {
        const candidates = team.members
          .filter((member) => member.userId !== userId)
          .sort((left, right) => {
            const roleOrder = (role: string) =>
              role === 'owner' ? 0 : role === 'admin' ? 1 : 2;
            return (
              roleOrder(left.role) - roleOrder(right.role) ||
              left.createdAt.getTime() - right.createdAt.getTime()
            );
          });
        const successor = candidates[0];
        if (!successor) {
          await tx.team.delete({ where: { id: team.id } });
          continue;
        }
        if (successor.role !== 'owner') {
          await tx.teamMember.updateMany({
            where: { teamId: team.id, userId: successor.userId },
            data: { role: 'owner' },
          });
        }
        if (team.createdBy === userId) {
          await tx.team.update({
            where: { id: team.id },
            data: { createdBy: successor.userId },
          });
        }
      }
      await tx.secret.deleteMany({ where: { ownerId: userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.apiKey.deleteMany({ where: { userId } });
      await tx.emailOtp.deleteMany({ where: { userId } });
      await tx.policy.deleteMany({ where: { ownerId: userId } });
      await tx.teamInvitation.deleteMany({ where: { inviterId: userId } });
      await tx.teamMember.deleteMany({ where: { userId } });
      await tx.abuseReport.updateMany({
        where: { reporterId: userId },
        data: { reporterId: null },
      });
      await tx.auditEvent.updateMany({
        where: { actorId: userId },
        data: { actorId: null },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId}@deleted.invalid`,
          passwordHash: randomBytes(32).toString('hex'),
          cognitoSubject: null,
          emailVerifiedAt: null,
          notificationPreferences: {},
          plan: 'free',
          deletedAt: new Date(),
        },
      });
    });
    for (const secret of user.secrets) {
      await this.storagePurge.purgeSecret(secret.id, [
        secret.ciphertextRef,
        ...secret.files.map((file) => file.storageRef),
      ]);
    }
    return { deleted: true };
  }

  async markNotificationRead(userId: string, notificationId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new NotFoundException('Notification not found or already read');
    }
  }

  async markAllNotificationsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function isCognitoUserNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UserNotFoundException'
  );
}
