import {
  BadRequestException,
  ConflictException,
  GoneException,
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
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../common/auth/guards/cognito-auth.guard.js';
import type { CreateSecretDto } from './dto/create-secret.dto.js';
import type { RevealSecretDto } from './dto/reveal-secret.dto.js';
import type { ReportSecretDto } from './dto/report-secret.dto.js';
import type { CreateSecretRequestDto } from './dto/create-secret-request.dto.js';
import type { UpdateSecretRequestDto } from './dto/update-secret-request.dto.js';
import type { CreateFileUploadDto } from './dto/create-file-upload.dto.js';
import { RecipientAccessService } from './recipient-access.service.js';
import { StoragePurgeService } from '../storage/storage-purge.service.js';
import { normalizeNotificationPreferences } from '../common/notifications/notification-preferences.js';

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
    const data = validateCreate(dto, owner.plan);
    const result = await this.prisma.$transaction(async (tx) => {
      const secret = await tx.secret.create({
        data: { ...data, ownerId: owner.userId },
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
    return result;
  }

  async createAnonymous(dto: CreateSecretDto) {
    const data = validateAnonymousCreate(dto);
    return this.prisma.secret.create({
      data: { ...data, ownerId: null },
      select: metaSelect,
    });
  }

  async getMeta(id: string) {
    const secret = await this.prisma.secret.findUnique({
      where: { id },
      select: { ...metaSelect, authHash: true },
    });
    if (!secret) {
      throw new NotFoundException('Secret not found');
    }
    if (secret.expiresAt && secret.expiresAt <= new Date()) {
      throw new GoneException('Secret is unavailable');
    }
    if (
      secret.status !== 'active' ||
      secret.viewsUsed >= (secret.maxViews ?? 1)
    ) {
      throw new GoneException('Secret is unavailable');
    }
    return {
      ...withoutAuthHash(secret),
      requiresPassphrase: Boolean(secret.authHash),
    };
  }

  async reveal(id: string, dto: RevealSecretDto) {
    const candidate = await this.prisma.secret.findUnique({
      where: { id },
      select: {
        authHash: true,
        expiresAt: true,
        status: true,
        maxViews: true,
        viewsUsed: true,
        recipientEmailHash: true,
      },
    });
    if (!candidate || candidate.status !== 'active') {
      throw new GoneException('Secret is unavailable');
    }
    if (candidate.expiresAt && candidate.expiresAt <= new Date()) {
      throw new GoneException('Secret is unavailable');
    }
    if (candidate.recipientEmailHash) {
      if (!dto.accessToken) {
        throw new UnauthorizedException('Recipient access token is required');
      }
      await this.recipientAccess.verify(id, dto.accessToken);
    }
    if (candidate.authHash && !dto.auth) {
      throw new UnauthorizedException('Passphrase is required');
    }
    if (candidate.authHash && !safeHashCompare(candidate.authHash, dto.auth!)) {
      throw new UnauthorizedException('Passphrase is invalid');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.secret.updateMany({
        where: {
          id,
          status: 'active',
          ...(candidate.expiresAt ? { expiresAt: { gt: new Date() } } : {}),
          ...(candidate.maxViews !== null
            ? { viewsUsed: { lt: candidate.maxViews ?? 1 } }
            : {}),
        },
        data: {
          viewsUsed: { increment: 1 },
          status:
            candidate.maxViews !== null &&
            candidate.viewsUsed + 1 >= (candidate.maxViews ?? 1)
              ? 'viewed'
              : 'active',
        },
      });
      if (updated.count !== 1) {
        throw new GoneException('Secret is unavailable');
      }

      const material = await tx.secret.findUnique({
        where: { id },
        select: {
          ciphertextRef: true,
          iv: true,
          wrappedKey: true,
          salt: true,
          files: { select: { storageRef: true } },
        },
      });
      if (!material) {
        throw new GoneException('Secret is unavailable');
      }
      await tx.auditEvent.create({
        data: { eventType: 'secret_viewed', secretId: id },
      });
      return {
        material: {
          ciphertextRef: material.ciphertextRef,
          iv: material.iv,
          wrappedKey: material.wrappedKey,
          salt: material.salt,
        },
        terminal:
          candidate.maxViews !== null &&
          candidate.viewsUsed + 1 >= (candidate.maxViews ?? 1),
        storageRefs: [
          material.ciphertextRef,
          ...material.files.map((file) => file.storageRef),
        ],
      };
    });
    if (result.terminal) {
      await this.storagePurge.purgeSecret(id, result.storageRefs);
    }
    return result.material;
  }

  async revoke(id: string, owner: AuthenticatedUser): Promise<void> {
    const storage = await this.prisma.secret.findFirst({
      where: { id, ownerId: owner.userId, status: 'active' },
      select: {
        ciphertextRef: true,
        files: { select: { storageRef: true } },
      },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.secret.updateMany({
        where: { id, ownerId: owner.userId, status: 'active' },
        data: { status: 'revoked' },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Secret cannot be revoked');
      }
      await tx.auditEvent.create({
        data: {
          eventType: 'secret_revoked',
          secretId: id,
          actorId: owner.userId,
        },
      });
      return updated;
    });
    if (result.count !== 1) {
      throw new NotFoundException('Secret not found');
    }
    if (storage) {
      await this.storagePurge.purgeSecret(id, [
        storage.ciphertextRef,
        ...storage.files.map((file) => file.storageRef),
      ]);
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
      select: { id: true },
    });
    if (!secret) throw new NotFoundException('Secret not found');
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
    const region = this.config.get<string>('S3_REGION');
    const bucket = this.config.get<string>('S3_BUCKET');
    if (!region || !bucket) {
      throw new ServiceUnavailableException('S3 storage is not configured');
    }
    const storageRef = `secrets/${secretId}/files/${randomStorageId()}-${safeFilename(filename)}`;
    const client = new S3Client({ region });
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
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
      },
    });
    if (!file) throw new NotFoundException('File not found');

    const { client, bucket } = this.getS3Storage();
    let object;
    try {
      object = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: file.storageRef }),
      );
    } catch (error) {
      if (isMissingS3Object(error)) {
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
    const { client, bucket } = this.getS3Storage();
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

  private getS3Storage() {
    const region = this.config.get<string>('S3_REGION');
    const bucket = this.config.get<string>('S3_BUCKET');
    if (!region || !bucket) {
      throw new ServiceUnavailableException('S3 storage is not configured');
    }
    return { client: new S3Client({ region }), bucket };
  }
}

function validateCreate(dto: CreateSecretDto, plan: string) {
  const textFields = ['ciphertextRef', 'iv', 'wrappedKey', 'salt'] as const;
  for (const field of textFields) {
    if (!dto[field]?.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
  }
  const maxAllowedViews = plan === 'free' ? 10 : 100;
  if (
    dto.maxViews !== undefined &&
    (!Number.isInteger(dto.maxViews) ||
      dto.maxViews < 1 ||
      dto.maxViews > maxAllowedViews)
  ) {
    throw new BadRequestException(
      `maxViews must be an integer between 1 and ${maxAllowedViews}`,
    );
  }
  const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
  if (dto.expiresAt && (!expiresAt || Number.isNaN(expiresAt.getTime()))) {
    throw new BadRequestException('expiresAt must be a valid ISO date');
  }
  if (expiresAt && expiresAt <= new Date()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  const maxExpiryDays = plan === 'free' ? 7 : 30;
  if (
    expiresAt &&
    expiresAt.getTime() > Date.now() + maxExpiryDays * 24 * 60 * 60 * 1000
  ) {
    throw new ConflictException(
      `The ${plan} plan allows expiry up to ${maxExpiryDays} days`,
    );
  }
  return {
    ciphertextRef: dto.ciphertextRef.trim(),
    iv: dto.iv.trim(),
    wrappedKey: dto.wrappedKey.trim(),
    salt: dto.salt.trim(),
    authHash: dto.authHash?.trim() || null,
    label: dto.label?.trim().slice(0, 200) || null,
    maxViews: dto.maxViews ?? 1,
    expiresAt,
    recipientEmailHash: dto.recipientEmailHash?.trim() || null,
  };
}

function validateAnonymousCreate(dto: CreateSecretDto) {
  const data = validateCreate(dto, 'anonymous');
  const now = Date.now();
  if (data.ciphertextRef.length > 64 * 1024) {
    throw new BadRequestException('Anonymous secrets are limited to 64 KB');
  }
  if (data.wrappedKey.length > 8192) {
    throw new BadRequestException('Anonymous wrapped keys are too large');
  }
  if (data.maxViews > 3) {
    throw new BadRequestException('Anonymous secrets allow at most 3 views');
  }
  if (!data.expiresAt || data.expiresAt.getTime() > now + 24 * 60 * 60 * 1000) {
    throw new BadRequestException(
      'Anonymous secrets must expire within 24 hours',
    );
  }
  return data;
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

function withoutAuthHash<T extends { authHash: string | null }>(secret: T) {
  const { authHash: _authHash, ...safe } = secret;
  return safe;
}

function isMissingS3Object(error: unknown): boolean {
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
