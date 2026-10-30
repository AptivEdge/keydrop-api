import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import type { CreateSecretDto } from './dto/create-secret.dto.js';
import type { RevealSecretDto } from './dto/reveal-secret.dto.js';
import type { ReportSecretDto } from './dto/report-secret.dto.js';
import type { CreateSecretRequestDto } from './dto/create-secret-request.dto.js';
import type { UpdateSecretRequestDto } from './dto/update-secret-request.dto.js';
import type { CreateFileUploadDto } from './dto/create-file-upload.dto.js';
import { RecipientAccessService } from './recipient-access.service.js';
import { StoragePurgeService } from '../storage/storage-purge.service.js';
import { normalizeNotificationPreferences } from '../common/notifications/notification-preferences.js';
import {
  createObjectStorageClient,
  getObjectStorageOptions,
} from '../providers/object-storage-options.js';

const metaSelect = {
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
export class SecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly recipientAccess: RecipientAccessService,
    private readonly storagePurge: StoragePurgeService,
  ) {}

  async create(owner: AuthenticatedUser, dto: CreateSecretDto) {
    if (owner.plan !== 'pro' && owner.plan !== 'team') {
      throw new ForbiddenException(
        'Creating secrets requires an active Pro or Team subscription',
      );
    }
    const data = validateCreate(dto, owner.plan, this.config);
    const result = await this.prisma.$transaction(async (tx) => {
      const secret = await tx.secret.create({
        data: { ...data, id: generatePublicId(), ownerId: owner.userId },
        select: metaSelect,
      });
      await tx.auditEvent.create({
        data: {
          eventType: 'secret_created',
          secretId: secret.id,
          actorId: owner.userId,
        },
      });
      return secret;
    });
    return createResponse(result);
  }

  async createAnonymous(): Promise<never> {
    throw new ForbiddenException(
      'Creating secrets requires an authenticated Pro or Team subscription',
    );
  }

  async getMeta(id: string) {
    validateSecretId(id);
    const secret = await this.prisma.secret.findUnique({
      where: { id },
      select: {
        ...metaSelect,
        authHash: true,
        recipientEmailHash: true,
        kdf: true,
      },
    });
    if (!secret) {
      throw new GoneException('Secret is unavailable');
    }
    if (secret.expiresAt && secret.expiresAt <= new Date()) {
      await this.expireSecret(id);
      throw new GoneException('Secret is unavailable');
    }
    if (
      !['active', 'partially_viewed'].includes(secret.status) ||
      secret.viewsUsed >= (secret.maxViews ?? 1)
    ) {
      throw new GoneException('Secret is unavailable');
    }
    return {
      id: secret.id,
      label: secret.label,
      status: secret.status,
      max_views: secret.maxViews,
      views_used: secret.viewsUsed,
      expires_at: secret.expiresAt,
      created_at: secret.createdAt,
      updated_at: secret.updatedAt,
      requires_passphrase: Boolean(secret.authHash),
      requires_email_verification: Boolean(secret.recipientEmailHash),
      kdf: secret.kdf,
    };
  }

  async reveal(id: string, dto: RevealSecretDto) {
    validateSecretId(id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = await this.prisma.secret.findUnique({
        where: { id },
        select: {
          authHash: true,
          ciphertext: true,
          ciphertextRef: true,
          expiresAt: true,
          status: true,
          maxViews: true,
          viewsUsed: true,
          passphraseAttempts: true,
          recipientEmailHash: true,
        },
      });
      if (
        !candidate ||
        !['active', 'partially_viewed'].includes(candidate.status)
      ) {
        throw new GoneException('Secret is unavailable');
      }
      if (candidate.expiresAt && candidate.expiresAt <= new Date()) {
        await this.expireSecret(id);
        throw new GoneException('Secret is unavailable');
      }
      if (candidate.recipientEmailHash) {
        if (!dto.access_token) {
          throw new UnauthorizedException('Recipient access token is required');
        }
        await this.recipientAccess.verify(id, dto.access_token);
      }
      if (candidate.authHash) {
        if (!dto.auth) {
          throw new UnauthorizedException({
            code: 'passphrase_required',
            message: 'Passphrase is required',
          });
        }
        if (
          !this.verifyAuth(
            candidate.authHash,
            dto.auth,
            candidate.ciphertext,
            candidate.ciphertextRef,
          )
        ) {
          const failed = await this.recordPassphraseFailure(id);
          if (failed.locked) {
            throw new HttpException(
              { code: 'secret_locked', message: 'Secret is locked' },
              HttpStatus.LOCKED,
            );
          }
          if (!failed.updated) {
            throw new GoneException('Secret is unavailable');
          }
          throw new UnauthorizedException({
            code: 'passphrase_invalid',
            message: 'Passphrase is invalid',
            attempts_left: failed.attemptsLeft,
          });
        }
      }

      const result = await this.prisma.$transaction(async (tx) => {
        const material = await tx.secret.findUnique({
          where: { id },
          select: {
            ciphertext: true,
            ciphertextRef: true,
            iv: true,
            kdf: true,
            wrappedKey: true,
            salt: true,
            files: { select: { storageRef: true } },
          },
        });
        if (
          !material ||
          (material.ciphertext === null && !material.ciphertextRef)
        ) {
          return null;
        }

        const nextViews = candidate.viewsUsed + 1;
        const terminal = nextViews >= (candidate.maxViews ?? 1);
        const updated = await tx.secret.updateMany({
          where: {
            id,
            status: candidate.status,
            viewsUsed: candidate.viewsUsed,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          data: {
            viewsUsed: nextViews,
            status: terminal ? 'viewed' : 'partially_viewed',
            ...(terminal
              ? {
                  ciphertext: null,
                  ciphertextRef: null,
                  authHash: null,
                  kdf: Prisma.DbNull,
                  wrappedKey: null,
                  salt: null,
                }
              : {}),
          },
        });
        if (updated.count !== 1) return null;

        await tx.auditEvent.create({
          data: { eventType: 'secret_viewed', secretId: id },
        });
        return {
          material,
          terminal,
          storageRefs: [
            material.ciphertextRef,
            ...material.files.map((file) => file.storageRef),
          ].filter((ref): ref is string => Boolean(ref)),
        };
      });
      if (!result) continue;
      if (result.terminal) {
        await this.storagePurge.purgeSecret(id, result.storageRefs);
      }
      if (result.material.ciphertext !== null) {
        return {
          ciphertext: result.material.ciphertext,
          iv: result.material.iv,
          kdf: result.material.kdf,
        };
      }
      return {
        ciphertextRef: result.material.ciphertextRef,
        iv: result.material.iv,
        wrappedKey: result.material.wrappedKey,
        salt: result.material.salt,
      };
    }
    throw new GoneException('Secret is unavailable');
  }

  async revoke(id: string, owner: AuthenticatedUser): Promise<void> {
    await this.revokeSecret(id, owner.userId, owner.userId);
  }

  async revokeByStaff(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
      throw new ConflictException(
        'Reason must be between 10 and 1000 characters',
      );
    }
    await this.revokeSecret(id, actorId, undefined, normalizedReason);
  }

  private async revokeSecret(
    id: string,
    actorId: string,
    ownerId?: string,
    staffReason?: string,
  ): Promise<void> {
    const storage = await this.prisma.secret.findFirst({
      where: {
        id,
        ...(ownerId ? { ownerId } : {}),
        status: { in: ['active', 'partially_viewed'] },
      },
      select: {
        ciphertextRef: true,
        files: { select: { storageRef: true } },
      },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.secret.updateMany({
        where: {
          id,
          ...(ownerId ? { ownerId } : {}),
          status: { in: ['active', 'partially_viewed'] },
        },
        data: {
          status: 'revoked',
          ciphertext: null,
          ciphertextRef: null,
          authHash: null,
          kdf: Prisma.DbNull,
          wrappedKey: null,
          salt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Secret cannot be revoked');
      }
      await tx.auditEvent.create({
        data: {
          eventType: 'secret_revoked',
          secretId: id,
          actorId,
        },
      });
      if (staffReason) {
        await tx.adminAuditLog.create({
          data: {
            actorId,
            action: 'secret_revoked_by_staff',
            targetType: 'secret',
            targetId: id,
            reason: staffReason,
          },
        });
      }
      return updated;
    });
    if (result.count !== 1) {
      throw new NotFoundException('Secret not found');
    }
    if (storage) {
      await this.storagePurge.purgeSecret(
        id,
        [
          storage.ciphertextRef,
          ...storage.files.map((file) => file.storageRef),
        ].filter((ref): ref is string => Boolean(ref)),
      );
    }
  }

  private verifyAuth(
    expectedHash: string,
    auth: string,
    ciphertext: string | null,
    ciphertextRef: string | null,
  ): boolean {
    if (ciphertext === null && ciphertextRef !== null) {
      return safeHashCompare(expectedHash, auth);
    }
    const pepper = this.config.get<string>('SECRET_AUTH_PEPPER');
    if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new ServiceUnavailableException(
        'SECRET_AUTH_PEPPER must contain at least 32 bytes',
      );
    }
    if (!isCanonicalBase64Url(auth)) return false;
    const authBytes = Buffer.from(auth, 'base64url');
    if (authBytes.length !== 32) return false;
    const candidate = createHmac('sha256', pepper)
      .update(authBytes)
      .digest('hex');
    return safeCompare(expectedHash, candidate);
  }

  private async recordPassphraseFailure(
    id: string,
  ): Promise<{ updated: boolean; locked: boolean; attemptsLeft: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const result = await tx.secret.updateMany({
        where: {
          id,
          status: { in: ['active', 'partially_viewed'] },
          passphraseAttempts: { lt: 3 },
        },
        data: { passphraseAttempts: { increment: 1 } },
      });
      if (result.count !== 1) {
        return {
          updated: false,
          locked: false,
          attemptsLeft: 0,
          storageRefs: [],
        };
      }

      const secret = await tx.secret.findUnique({
        where: { id },
        select: { passphraseAttempts: true, status: true },
      });
      if (!secret) {
        return {
          updated: false,
          locked: false,
          attemptsLeft: 0,
          storageRefs: [],
        };
      }
      const locked = secret.passphraseAttempts >= 3;
      let storageRefs: string[] = [];
      if (locked) {
        const material = await tx.secret.findUnique({
          where: { id },
          select: {
            ciphertextRef: true,
            files: { select: { storageRef: true } },
          },
        });
        storageRefs = [
          material?.ciphertextRef,
          ...(material?.files.map((file) => file.storageRef) ?? []),
        ].filter((ref): ref is string => Boolean(ref));
        await tx.secret.updateMany({
          where: {
            id,
            status: { in: ['active', 'partially_viewed'] },
            passphraseAttempts: { gte: 3 },
          },
          data: {
            status: 'locked',
            ciphertext: null,
            ciphertextRef: null,
            authHash: null,
            kdf: Prisma.DbNull,
            wrappedKey: null,
            salt: null,
          },
        });
        await tx.auditEvent.create({
          data: { eventType: 'locked', secretId: id },
        });
      } else {
        await tx.auditEvent.create({
          data: { eventType: 'passphrase_failed', secretId: id },
        });
      }
      return {
        updated: true,
        locked,
        attemptsLeft: Math.max(0, 3 - secret.passphraseAttempts),
        storageRefs,
      };
    });
    if (result.locked && result.storageRefs.length) {
      await this.storagePurge.purgeSecret(id, result.storageRefs);
    }
    return {
      updated: result.updated,
      locked: result.locked,
      attemptsLeft: result.attemptsLeft,
    };
  }

  private async expireSecret(id: string): Promise<void> {
    const storage = await this.prisma.secret.findUnique({
      where: { id },
      select: { ciphertextRef: true, files: { select: { storageRef: true } } },
    });
    const expired = await this.prisma.$transaction(async (tx) => {
      const result = await tx.secret.updateMany({
        where: {
          id,
          status: { in: ['active', 'partially_viewed'] },
          expiresAt: { lte: new Date() },
        },
        data: {
          status: 'expired',
          ciphertext: null,
          ciphertextRef: null,
          authHash: null,
          kdf: Prisma.DbNull,
          wrappedKey: null,
          salt: null,
        },
      });
      if (result.count) {
        await tx.auditEvent.create({
          data: { eventType: 'secret_expired', secretId: id },
        });
      }
      return result;
    });
    if (expired.count && storage) {
      await this.storagePurge.purgeSecret(
        id,
        [
          storage.ciphertextRef,
          ...storage.files.map((file) => file.storageRef),
        ].filter((ref): ref is string => Boolean(ref)),
      );
    }
  }

  async report(id: string, dto: ReportSecretDto, reporterId?: string) {
    if (!dto.reason?.trim()) {
      throw new BadRequestException('A report reason is required');
    }
    return this.prisma.$transaction(async (tx) => {
      const secret = await tx.secret.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!secret) {
        throw new NotFoundException('Secret not found');
      }
      const report = await tx.abuseReport.create({
        data: {
          secretId: id,
          reporterId,
          reason: dto.reason.trim().slice(0, 200),
          details: dto.details?.trim().slice(0, 2000),
        },
        select: { id: true, status: true, createdAt: true },
      });
      await tx.auditEvent.create({
        data: {
          eventType: 'abuse_reported',
          secretId: id,
          actorId: reporterId,
        },
      });
      return report;
    });
  }

  async createRequest(id: string, dto: CreateSecretRequestDto) {
    const email = dto.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required');
    }
    const secret = await this.prisma.secret.findUnique({
      where: { id },
      select: { id: true, ownerId: true, status: true, expiresAt: true },
    });
    if (!secret) throw new NotFoundException('Secret not found');
    if (
      secret.status !== 'active' ||
      (secret.expiresAt && secret.expiresAt <= new Date())
    ) {
      throw new GoneException('Secret is unavailable');
    }
    if (!secret.ownerId) {
      throw new ConflictException(
        'Anonymous secrets do not support owner access requests',
      );
    }
    const ownerId = secret.ownerId;
    const requesterEmailHash = hashValue(email);
    const existing = await this.prisma.secretRequest.findFirst({
      where: { secretId: id, requesterEmailHash, status: 'pending' },
    });
    if (existing) throw new ConflictException('A request is already pending');
    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.secretRequest.create({
        data: { secretId: id, requesterEmailHash },
        select: { id: true, status: true, createdAt: true },
      });
      const owner = await tx.user.findUnique({
        where: { id: ownerId },
        select: { notificationPreferences: true },
      });
      if (!owner) throw new NotFoundException('Secret owner not found');
      const preference = normalizeNotificationPreferences(
        owner.notificationPreferences,
      ).access_requested;
      await tx.notification.create({
        data: {
          userId: ownerId,
          secretId: id,
          type: 'access_requested',
          payload: { requestId: created.id },
          dedupeKey: `access_requested:${created.id}`,
          emailSentAt: preference.email ? null : new Date(),
        },
      });
      await tx.auditEvent.create({
        data: { eventType: 'access_requested', secretId: id },
      });
      return created;
    });
    return request;
  }

  async listRequests(id: string, ownerId: string) {
    const secret = await this.prisma.secret.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!secret) throw new NotFoundException('Secret not found');
    return this.prisma.secretRequest.findMany({
      where: { secretId: id },
      select: { id: true, status: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateRequest(
    id: string,
    requestId: string,
    ownerId: string,
    dto: UpdateSecretRequestDto,
  ) {
    if (dto.status !== 'approved' && dto.status !== 'denied') {
      throw new BadRequestException('status must be approved or denied');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const request = await tx.secretRequest.findFirst({
        where: { id: requestId, secretId: id, secret: { ownerId } },
        select: { id: true, status: true },
      });
      if (!request) throw new NotFoundException('Secret request not found');
      if (request.status !== 'pending') {
        throw new ConflictException('Secret request has already been resolved');
      }
      const updated = await tx.secretRequest.update({
        where: { id: request.id },
        data: { status: dto.status },
        select: { id: true, status: true, updatedAt: true },
      });
      await tx.auditEvent.create({
        data: {
          eventType:
            dto.status === 'approved' ? 'access_granted' : 'access_denied',
          secretId: id,
          actorId: ownerId,
        },
      });
      return updated;
    });
    return result;
  }

  async createFileUpload(
    secretId: string,
    ownerId: string,
    dto: CreateFileUploadDto,
  ) {
    const secret = await this.prisma.secret.findFirst({
      where: {
        id: secretId,
        ownerId,
        status: 'active',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, owner: { select: { plan: true } } },
    });
    if (!secret) throw new NotFoundException('Secret not found');
    if (!['pro', 'team'].includes(secret.owner?.plan ?? '')) {
      throw new ForbiddenException(
        'File uploads require an active Pro or Team subscription',
      );
    }
    const filename = dto.filename?.trim();
    const contentType = dto.contentType?.trim() || 'application/octet-stream';
    if (!filename || filename.length > 255) {
      throw new BadRequestException(
        'filename is required and must be at most 255 characters',
      );
    }
    if (
      !Number.isSafeInteger(dto.sizeBytes) ||
      dto.sizeBytes! < 1 ||
      dto.sizeBytes! > 256 * 1024 * 1024
    ) {
      throw new BadRequestException(
        'sizeBytes must be between 1 byte and 256 MB',
      );
    }
    const storage = getObjectStorageOptions(this.config);
    if (!storage) {
      throw new ServiceUnavailableException('Object storage is not configured');
    }
    const storageRef = `secrets/${secretId}/files/${randomStorageId()}-${safeFilename(filename)}`;
    const client = createObjectStorageClient(storage);
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: storageRef,
        ContentType: contentType,
      }),
      { expiresIn: 900 },
    );
    const file = await this.prisma.file.create({
      data: {
        secretId,
        storageRef,
        filename,
        contentType,
        sizeBytes: dto.sizeBytes,
      },
      select: {
        id: true,
        filename: true,
        contentType: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    return { ...file, uploadUrl, expiresIn: 900 };
  }

  async completeFileUpload(secretId: string, fileId: string, ownerId: string) {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        secretId,
        secret: {
          ownerId,
          status: 'active',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      select: {
        id: true,
        storageRef: true,
        sizeBytes: true,
        contentType: true,
        uploadedAt: true,
        secret: { select: { owner: { select: { plan: true } } } },
      },
    });
    if (!file) throw new NotFoundException('File not found');
    if (!['pro', 'team'].includes(file.secret.owner?.plan ?? '')) {
      throw new ForbiddenException(
        'File uploads require an active Pro or Team subscription',
      );
    }

    const { client, bucket } = this.getObjectStorage();
    let object;
    try {
      object = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: file.storageRef }),
      );
    } catch (error) {
      if (isMissingStoredObject(error)) {
        throw new ConflictException('File upload has not completed');
      }
      throw error;
    }
    if (
      object.ContentLength === undefined ||
      file.sizeBytes === null ||
      BigInt(object.ContentLength) !== file.sizeBytes ||
      (file.contentType && object.ContentType !== file.contentType)
    ) {
      throw new ConflictException(
        'Uploaded file does not match its declaration',
      );
    }

    if (file.uploadedAt) {
      return { id: file.id, uploaded: true, alreadyCompleted: true };
    }
    const updated = await this.prisma.file.updateMany({
      where: {
        id: file.id,
        uploadedAt: null,
        secret: {
          ownerId,
          status: 'active',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      data: { uploadedAt: new Date() },
    });
    if (updated.count === 0) {
      const completed = await this.prisma.file.findFirst({
        where: {
          id: file.id,
          uploadedAt: { not: null },
          secret: {
            ownerId,
            status: 'active',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        },
        select: { id: true },
      });
      if (!completed)
        throw new ConflictException('File is no longer uploadable');
    }
    return {
      id: file.id,
      uploaded: true,
      alreadyCompleted: updated.count === 0,
    };
  }

  async getFileDownloadUrl(secretId: string, fileId: string, ownerId: string) {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        secretId,
        uploadedAt: { not: null },
        secret: {
          ownerId,
          status: 'active',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      select: {
        id: true,
        storageRef: true,
        filename: true,
        contentType: true,
      },
    });
    if (!file) throw new NotFoundException('Uploaded file not found');
    const { client, bucket } = this.getObjectStorage();
    const downloadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: file.storageRef,
        ResponseContentDisposition: `attachment; filename="${safeFilename(file.filename ?? 'download')}"`,
        ...(file.contentType ? { ResponseContentType: file.contentType } : {}),
      }),
      { expiresIn: 900 },
    );
    return { id: file.id, downloadUrl, expiresIn: 900 };
  }

  private getObjectStorage() {
    const storage = getObjectStorageOptions(this.config);
    if (!storage) {
      throw new ServiceUnavailableException('Object storage is not configured');
    }
    return {
      client: createObjectStorageClient(storage),
      bucket: storage.bucket,
    };
  }
}

function validateCreate(
  dto: CreateSecretDto,
  plan: string,
  config: ConfigService,
) {
  const ciphertext = dto.ciphertext?.trim();
  const iv = dto.iv?.trim();
  if (!ciphertext) throw new BadRequestException('ciphertext is required');
  if (!iv) throw new BadRequestException('iv is required');
  if (!dto.kdf || typeof dto.kdf !== 'object') {
    throw new BadRequestException('kdf parameters are required');
  }

  const encryptedBytes = decodeBase64Url(ciphertext, 'ciphertext');
  const ivBytes = decodeBase64Url(iv, 'iv');
  if (ivBytes.length !== 12) {
    throw new BadRequestException('iv must encode exactly 12 random bytes');
  }

  const maxPaddedBytes = 256 * 1024 + 4;
  if (encryptedBytes.length > maxPaddedBytes + 16) {
    throw new BadRequestException(
      `Ciphertext exceeds the ${plan} plan size limit`,
    );
  }

  validateKdf(dto.kdf, dto.auth);
  const maxAllowedViews = 100;
  const maxViews = dto.max_views ?? 1;
  if (
    !Number.isInteger(maxViews) ||
    maxViews < 1 ||
    maxViews > maxAllowedViews
  ) {
    throw new BadRequestException(
      `max_views is not allowed for the ${plan} plan`,
    );
  }

  const maxExpirySeconds = 30 * 86400;
  if (
    !Number.isInteger(dto.expires_in) ||
    dto.expires_in < 60 ||
    dto.expires_in > maxExpirySeconds
  ) {
    throw new ConflictException(
      `expires_in must be between 60 and ${maxExpirySeconds} seconds for the ${plan} plan`,
    );
  }

  const recipientEmail = dto.recipient_email?.trim().toLowerCase() || null;
  if (recipientEmail && !['pro', 'team'].includes(plan)) {
    throw new ConflictException(
      'Recipient email verification requires a Pro or Team plan',
    );
  }
  let authHash: string | null = null;
  if (dto.auth) {
    const pepper = config.get<string>('SECRET_AUTH_PEPPER');
    if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new ServiceUnavailableException(
        'SECRET_AUTH_PEPPER must contain at least 32 bytes',
      );
    }
    const authBytes = decodeBase64Url(dto.auth, 'auth');
    if (authBytes.length !== 32) {
      throw new BadRequestException('auth must encode exactly 32 bytes');
    }
    authHash = createHmac('sha256', pepper).update(authBytes).digest('hex');
  }

  return {
    ciphertext,
    ciphertextRef: null,
    iv,
    wrappedKey: null,
    salt: null,
    kdf: {
      algorithm: dto.kdf.algorithm,
      ...(dto.kdf.salt ? { salt: dto.kdf.salt } : {}),
      ...(dto.kdf.parameters ? { parameters: { ...dto.kdf.parameters } } : {}),
    } satisfies Prisma.InputJsonObject,
    authHash,
    label: dto.label?.trim().slice(0, 200) || null,
    maxViews,
    expiresAt: new Date(Date.now() + dto.expires_in * 1000),
    recipientEmail,
    recipientEmailHash: recipientEmail ? hashValue(recipientEmail) : null,
  };
}

function validateKdf(kdf: CreateSecretDto['kdf'], auth?: string): void {
  if (kdf.algorithm === 'Argon2id') {
    const parameters = kdf.parameters;
    const saltBytes = kdf.salt
      ? decodeBase64Url(kdf.salt, 'kdf.salt')
      : Buffer.alloc(0);
    if (
      !auth ||
      saltBytes.length !== 16 ||
      parameters?.m !== 65536 ||
      parameters.t !== 3 ||
      parameters.p !== 1
    ) {
      throw new BadRequestException(
        'Argon2id requires a passphrase and the supported m=65536, t=3, p=1 parameters',
      );
    }
  } else if (auth) {
    throw new BadRequestException(
      'Passphrase authentication requires Argon2id KDF parameters',
    );
  }
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!isCanonicalBase64Url(value)) {
    throw new BadRequestException(`${field} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new BadRequestException(`${field} must be valid unpadded base64url`);
  }
  return decoded;
}

function isCanonicalBase64Url(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

function createResponse(secret: {
  id: string;
  status: string;
  maxViews: number | null;
  expiresAt: Date | null;
}) {
  return {
    id: secret.id,
    status: secret.status,
    expires_at: secret.expiresAt,
    max_views: secret.maxViews,
  };
}

function generatePublicId(): string {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return Array.from(
    { length: 22 },
    () => alphabet[randomInt(alphabet.length)],
  ).join('');
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validateSecretId(id: string): void {
  if (!/^[0-9A-Za-z]{22}$/.test(id) && !/^[a-z0-9]{25}$/.test(id)) {
    throw new NotFoundException('Secret not found');
  }
}

function safeHashCompare(expectedHash: string, candidate: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest('hex');
  const expected = Buffer.from(expectedHash, 'utf8');
  const actual = Buffer.from(candidateHash, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomStorageId(): string {
  return randomBytes(18).toString('hex');
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function isMissingStoredObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    error.$metadata.httpStatusCode === 404
  ) {
    return true;
  }
  return (
    'name' in error && (error.name === 'NotFound' || error.name === 'NoSuchKey')
  );
}
