import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';

const userSelect = {
  id: true,
  email: true,
  identitySubject: true,
  plan: true,
  emailVerifiedAt: true,
  suspendedAt: true,
  suspensionReason: true,
  createdAt: true,
  updatedAt: true,
  adminUser: { select: { role: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async assertNotBlocklisted(email: string, userId?: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const domain = normalizedEmail.split('@')[1];
    const resolvedUserId = userId ?? (await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    }))?.id;
    const now = new Date();
    const blocklistEntry = await this.prisma.adminBlocklistEntry.findFirst({
      where: {
        OR: [
          ...(resolvedUserId ? [{ kind: 'account' as const, value: resolvedUserId }] : []),
          { kind: 'email_domain', value: domain },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { kind: true },
    });
    if (blocklistEntry) {
      throw new ForbiddenException('This account is not permitted to use Keydrop');
    }
  }

  findAdminAccounts() {
    return this.prisma.adminUser.findMany({
      where: { user: { deletedAt: null } },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAdminIdentity(identitySubject: string, email: string) {
    const normalizedEmail = normalizeEmail(email);
    try {
      return await this.createAdminIdentityRecord(
        this.prisma,
        identitySubject,
        normalizedEmail,
      );
    } catch (error: unknown) {
      this.throwAdminIdentityError(error);
    }
  }

  async createFirstAdminIdentity(identitySubject: string, email: string) {
    const normalizedEmail = normalizeEmail(email);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended('keydrop:first-admin-bootstrap', 0)
          )::text AS locked
        `;
        const existingAdmins = await transaction.adminUser.count({
          where: { role: 'ADM' },
        });
        if (existingAdmins > 0) {
          throw new ConflictException(
            'An ADM account already exists; use the Admin accounts page',
          );
        }

        return this.createAdminIdentityRecord(
          transaction,
          identitySubject,
          normalizedEmail,
        );
      });
    } catch (error: unknown) {
      this.throwAdminIdentityError(error);
    }
  }

  private createAdminIdentityRecord(
    database: Pick<Prisma.TransactionClient, 'user'>,
    identitySubject: string,
    email: string,
  ) {
    return database.user.create({
      data: {
        email,
        identitySubject,
        passwordHash: randomBytes(32).toString('hex'),
        adminUser: {
          create: { role: 'ADM', ssoSubject: identitySubject },
        },
      },
      select: {
        id: true,
        email: true,
        identitySubject: true,
        adminUser: { select: { role: true } },
      },
    });
  }

  private throwAdminIdentityError(error: unknown): never {
    if (error instanceof ConflictException) throw error;
    if (isUniqueConstraintError(error)) {
      throw new ConflictException(
        'An account with this email or identity already exists',
      );
    }
    throw error;
  }

  async removeProvisionedAdmin(identitySubject: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { identitySubject },
        select: { id: true, adminUser: { select: { role: true } } },
      });
      if (!user) return;
      if (user.adminUser?.role !== 'ADM') {
        throw new Error('Provisioned admin identity changed before cleanup');
      }
      await transaction.adminUser.delete({ where: { userId: user.id } });
      await transaction.user.delete({ where: { id: user.id } });
    });
  }

  findAll() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      select: userSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: userSelect,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async create(dto: CreateUserDto) {
    const email = normalizeEmail(dto.email);
    const identitySubject = requireText(dto.identitySubject, 'identitySubject');
    try {
      return await this.prisma.user.create({
        data: {
          email,
          identitySubject,
          plan: dto.plan ?? 'free',
          passwordHash: randomBytes(32).toString('hex'),
        },
        select: userSelect,
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'A user with this email or identity subject already exists',
        );
      }
      throw error;
    }
  }

  async upsertFromIdentity(
    identitySubject: string,
    email: string,
    emailVerified: boolean,
  ) {
    const normalizedEmail = normalizeEmail(email);
    try {
      return await this.prisma.user.upsert({
        where: { identitySubject },
        create: {
          email: normalizedEmail,
          identitySubject,
          passwordHash: randomBytes(32).toString('hex'),
          emailVerifiedAt: emailVerified ? new Date() : null,
        },
        update: {
          email: normalizedEmail,
          ...(emailVerified ? { emailVerifiedAt: new Date() } : {}),
        },
        select: userSelect,
      });
    } catch (error: unknown) {
      if (!emailVerified || !isUniqueConstraintError(error)) throw error;

      const existingUser = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, deletedAt: true },
      });
      if (!existingUser || existingUser.deletedAt) throw error;

      try {
        return await this.prisma.user.update({
          where: { id: existingUser.id },
          data: {
            identitySubject,
            emailVerifiedAt: new Date(),
          },
          select: userSelect,
        });
      } catch (linkError: unknown) {
        if (isUniqueConstraintError(linkError)) {
          throw new ConflictException(
            'This account is already linked to another identity',
          );
        }
        throw linkError;
      }
    }
  }

  async upsertCustomerFromOAuth(identitySubject: string, email: string) {
    const normalizedEmail = normalizeEmail(email);
    return this.prisma.$transaction(async (transaction) => {
      const identityUser = await transaction.user.findUnique({
        where: { identitySubject },
        select: {
          id: true,
          email: true,
          deletedAt: true,
          adminUser: { select: { role: true } },
        },
      });
      const emailUser = await transaction.user.findUnique({
        where: { email: normalizedEmail },
        select: {
          id: true,
          identitySubject: true,
          deletedAt: true,
          adminUser: { select: { role: true } },
        },
      });

      if (identityUser?.adminUser || emailUser?.adminUser) {
        throw new ForbiddenException(
          'Staff accounts cannot sign in through customer OAuth',
        );
      }
      if (identityUser?.deletedAt || emailUser?.deletedAt) {
        throw new NotFoundException('Customer account is not available');
      }
      if (
        identityUser
        && emailUser
        && identityUser.id !== emailUser.id
      ) {
        throw new ConflictException(
          'This GitHub identity is linked to a different Keydrop account',
        );
      }
      if (
        emailUser?.identitySubject
        && emailUser.identitySubject !== identitySubject
      ) {
        throw new ConflictException(
          'This email is already linked to another sign-in identity',
        );
      }

      const existingUser = identityUser ?? emailUser;
      if (existingUser) {
        return transaction.user.update({
          where: { id: existingUser.id },
          data: {
            email: normalizedEmail,
            identitySubject,
            emailVerifiedAt: new Date(),
          },
          select: userSelect,
        });
      }

      return transaction.user.create({
        data: {
          email: normalizedEmail,
          identitySubject,
          passwordHash: randomBytes(32).toString('hex'),
          emailVerifiedAt: new Date(),
        },
        select: userSelect,
      });
    });
  }

  async findIdentitySubjectByEmail(email: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { identitySubject: true },
    });
    return user?.identitySubject ?? null;
  }

  async update(id: string, dto: UpdateUserDto) {
    await this.findById(id);
    const data = {
      ...(dto.email === undefined ? {} : { email: normalizeEmail(dto.email) }),
      ...(dto.plan === undefined ? {} : { plan: dto.plan }),
      ...(dto.email === undefined ? {} : { emailVerifiedAt: null }),
    };
    try {
      return await this.prisma.user.update({
        where: { id },
        data,
        select: userSelect,
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.user.delete({ where: { id } });
  }

  async setSuspended(
    id: string,
    actorId: string,
    reason: string,
    suspended: boolean,
  ) {
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
      throw new BadRequestException('Reason must be between 10 and 1000 characters');
    }
    if (id === actorId) {
      throw new ForbiddenException('Staff cannot moderate their own account');
    }

    const existing = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, adminUser: { select: { role: true } }, suspendedAt: true },
    });
    if (!existing) throw new NotFoundException('User not found');
    if (existing.adminUser) {
      throw new ForbiddenException('Staff accounts must be managed through the staff-account workflow');
    }
    if (Boolean(existing.suspendedAt) === suspended) {
      throw new ConflictException(suspended ? 'User is already suspended' : 'User is not suspended');
    }

    const updatedAt = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.user.updateMany({
        where: {
          id,
          deletedAt: null,
          suspendedAt: suspended ? null : { not: null },
          adminUser: { is: null },
        },
        data: suspended
          ? { suspendedAt: updatedAt, suspensionReason: normalizedReason }
          : { suspendedAt: null, suspensionReason: null },
      });
      if (changed.count !== 1) {
        throw new ConflictException('Account moderation state changed; refresh and retry');
      }
      const user = await transaction.user.findUnique({
        where: { id },
        select: userSelect,
      });
      if (!user) throw new NotFoundException('User not found');
      await transaction.adminAuditLog.create({
        data: {
          actorId,
          action: suspended ? 'user_suspended' : 'user_unsuspended',
          targetType: 'user',
          targetId: id,
          reason: normalizedReason,
        },
      });
      return user;
    });
  }
}

function normalizeEmail(value: string): string {
  const email = requireText(value, 'email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ConflictException('A valid email address is required');
  }
  return email;
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConflictException(`${field} is required`);
  }
  return value.trim();
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
