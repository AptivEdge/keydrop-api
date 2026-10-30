import { randomInt, createECDH } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cursorPage,
  cursorPaginationArgs,
} from '../common/dto/cursor-pagination.dto.js';
import { EmailDeliveryService } from '../teams/email-delivery.service.js';
import type { CreateSecretRequestLinkDto } from './dto/create-secret-request-link.dto.js';
import type { RespondToSecretRequestDto } from './dto/respond-to-secret-request.dto.js';

const publicIdAlphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const requestSummary = {
  id: true,
  title: true,
  recipientEmail: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  fulfilledAt: true,
} as const;

@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailDeliveryService,
  ) {}

  async create(userId: string, dto: CreateSecretRequestLinkDto) {
    await this.requirePro(userId);
    if (dto.expires_in > 30 * 24 * 60 * 60) {
      throw new ConflictException('Request expiry cannot exceed 30 days');
    }
    const publicKey = decodeP256PublicKey(dto.public_key, 'public_key');
    const id = generatePublicId();
    const requestUrl = dto.recipient_email ? this.requestUrl(id) : null;
    const now = new Date();
    const request = await this.prisma.secretRequestLink.create({
      data: {
        id,
        ownerId: userId,
        title: dto.title.trim(),
        instructions: dto.instructions.trim(),
        publicKey: publicKey.toString('base64url'),
        recipientEmail: dto.recipient_email?.trim().toLowerCase() || null,
        expiresAt: new Date(now.getTime() + dto.expires_in * 1000),
      },
      select: requestSummary,
    });

    let emailSent: boolean | null = null;
    if (request.recipientEmail) {
      if (!requestUrl) {
        throw new ServiceUnavailableException('Request invitation URL is unavailable');
      }
      try {
        await this.email.sendSecretRequestInvitation(
          request.recipientEmail,
          request.title,
          requestUrl,
          request.expiresAt,
        );
        emailSent = true;
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        emailSent = false;
      }
    }

    return { ...request, emailSent };
  }

  async list(userId: string, cursor?: string, limit = 50) {
    await this.requirePro(userId);
    const rows = await this.prisma.secretRequestLink.findMany({
      where: { ownerId: userId },
      select: requestSummary,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorPaginationArgs(cursor, limit),
    });
    const now = new Date();
    return cursorPage(
      rows.map((row) => ({
        ...row,
        status: row.status === 'pending' && row.expiresAt <= now
          ? 'expired'
          : row.status,
      })),
      limit,
    );
  }

  async getOwned(userId: string, requestId: string) {
    await this.requirePro(userId);
    const request = await this.prisma.secretRequestLink.findFirst({
      where: { id: requestId, ownerId: userId },
      select: {
        ...requestSummary,
        instructions: true,
        publicKey: true,
        responseCiphertext: true,
        responseIv: true,
        responseSalt: true,
        responsePublicKey: true,
      },
    });
    if (!request) throw new NotFoundException('Request not found');

    const expired =
      request.expiresAt <= new Date() && request.status !== 'cancelled';
    const responseReady = !expired && request.status === 'fulfilled';
    if (
      responseReady
      && (
        !request.responseCiphertext
        || !request.responseIv
        || !request.responseSalt
        || !request.responsePublicKey
      )
    ) {
      throw new ServiceUnavailableException('The encrypted response is incomplete');
    }
    return {
      id: request.id,
      title: request.title,
      instructions: request.instructions,
      recipientEmail: request.recipientEmail,
      status: expired ? 'expired' : request.status,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
      fulfilledAt: request.fulfilledAt,
      publicKey: request.publicKey,
      response: responseReady
        ? {
            ciphertext: request.responseCiphertext,
            iv: request.responseIv,
            salt: request.responseSalt,
            ephemeralPublicKey: request.responsePublicKey,
          }
        : null,
    };
  }

  async getPublicMeta(requestId: string) {
    const request = await this.prisma.secretRequestLink.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        title: true,
        instructions: true,
        publicKey: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status === 'cancelled' || request.expiresAt <= new Date()) {
      return {
        id: request.id,
        title: request.title,
        status: request.status === 'cancelled' ? 'cancelled' : 'expired',
        expiresAt: request.expiresAt,
      };
    }
    return {
      id: request.id,
      title: request.title,
      instructions: request.instructions,
      publicKey: request.publicKey,
      status: request.status,
      expiresAt: request.expiresAt,
    };
  }

  async respond(requestId: string, dto: RespondToSecretRequestDto) {
    const ephemeralPublicKey = decodeP256PublicKey(
      dto.ephemeral_public_key,
      'ephemeral_public_key',
    );
    const ciphertext = decodeBase64Url(dto.ciphertext, 'ciphertext');
    const iv = decodeBase64Url(dto.iv, 'iv');
    const salt = decodeBase64Url(dto.salt, 'salt');
    if (iv.length !== 12)     throw new BadRequestException('iv must encode 12 bytes');
    if (salt.length !== 16)     throw new BadRequestException('salt must encode 16 bytes');
    if (ciphertext.length < 16 || ciphertext.length > 262_164) {
      throw new BadRequestException('Encrypted response is outside the permitted size');
    }

    const now = new Date();
    const updated = await this.prisma.secretRequestLink.updateMany({
      where: {
        id: requestId,
        status: 'pending',
        expiresAt: { gt: now },
      },
      data: {
        status: 'fulfilled',
        responseCiphertext: ciphertext.toString('base64url'),
        responseIv: iv.toString('base64url'),
        responseSalt: salt.toString('base64url'),
        responsePublicKey: ephemeralPublicKey.toString('base64url'),
        fulfilledAt: now,
      },
    });
    if (updated.count !== 1) {
      const request = await this.prisma.secretRequestLink.findUnique({
        where: { id: requestId },
        select: { status: true, expiresAt: true },
      });
      if (!request) throw new NotFoundException('Request not found');
      if (request.expiresAt <= now || request.status === 'expired') {
        throw new GoneException('This request has expired');
      }
      throw new ConflictException('This request can no longer be fulfilled');
    }
    return { id: requestId, status: 'fulfilled', fulfilledAt: now };
  }

  async cancel(userId: string, requestId: string) {
    await this.requirePro(userId);
    const now = new Date();
    const updated = await this.prisma.secretRequestLink.updateMany({
      where: {
        id: requestId,
        ownerId: userId,
        status: 'pending',
        expiresAt: { gt: now },
      },
      data: {
        status: 'cancelled',
        responseCiphertext: null,
        responseIv: null,
        responseSalt: null,
        responsePublicKey: null,
      },
    });
    if (updated.count !== 1) {
      const request = await this.prisma.secretRequestLink.findFirst({
        where: { id: requestId, ownerId: userId },
        select: { status: true, expiresAt: true },
      });
      if (!request) throw new NotFoundException('Request not found');
      if (request.expiresAt <= now || request.status === 'expired') {
        throw new GoneException('This request has expired');
      }
      throw new ConflictException('Only pending requests can be cancelled');
    }
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.prisma.secretRequestLink.updateMany({
      where: {
        status: { in: ['pending', 'fulfilled'] },
        expiresAt: { lte: new Date() },
      },
      data: {
        status: 'expired',
        responseCiphertext: null,
        responseIv: null,
        responseSalt: null,
        responsePublicKey: null,
      },
    });
    return result.count;
  }

  private async requirePro(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { plan: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.plan === 'free') {
      throw new ForbiddenException('Secret requests require a Pro or Team plan');
    }
  }

  private requestUrl(id: string) {
    const configuredUrl = this.config.get<string>('FRONTEND_URL');
    const frontendUrl = configuredUrl?.split(',')[0]?.trim()
      || (this.config.get<string>('NODE_ENV') === 'production'
        ? null
        : 'http://localhost:3000');
    if (!frontendUrl) {
      throw new ServiceUnavailableException('FRONTEND_URL is not configured');
    }

    let url: URL;
    try {
      url = new URL(frontendUrl);
    } catch {
      throw new ServiceUnavailableException('FRONTEND_URL is invalid');
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || (this.config.get<string>('NODE_ENV') === 'production' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      throw new ServiceUnavailableException('FRONTEND_URL is invalid');
    }
    return new URL(`/r/${id}`, url).toString();
  }
}

function generatePublicId(): string {
  return Array.from(
    { length: 22 },
    () => publicIdAlphabet[randomInt(publicIdAlphabet.length)],
  ).join('');
}

function decodeP256PublicKey(value: string, field: string): Buffer {
  const key = decodeBase64Url(value, field);
  if (key.length !== 65 || key[0] !== 4) {
    throw new BadRequestException(`${field} must be a raw P-256 public key`);
  }
  try {
    const validator = createECDH('prime256v1');
    validator.generateKeys();
    validator.computeSecret(key);
  } catch {
    throw new BadRequestException(`${field} is not a valid P-256 public key`);
  }
  return key;
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BadRequestException(`${field} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new BadRequestException(`${field} must be canonical base64url`);
  }
  return decoded;
}
