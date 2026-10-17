import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';

const userSelect = {
  id: true,
  email: true,
  cognitoSubject: true,
  plan: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
  adminUser: { select: { role: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
    const cognitoSubject = requireText(dto.cognitoSubject, 'cognitoSubject');
    try {
      return await this.prisma.user.create({
        data: {
          email,
          cognitoSubject,
          plan: dto.plan ?? 'free',
          passwordHash: randomBytes(32).toString('hex'),
        },
        select: userSelect,
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'A user with this email or Cognito subject already exists',
        );
      }
      throw error;
    }
  }

  async upsertFromCognito(cognitoSubject: string, email: string) {
    const normalizedEmail = normalizeEmail(email);
    return this.prisma.user.upsert({
      where: { cognitoSubject },
      create: {
        email: normalizedEmail,
        cognitoSubject,
        passwordHash: randomBytes(32).toString('hex'),
        emailVerifiedAt: new Date(),
      },
      update: {
        email: normalizedEmail,
        emailVerifiedAt: new Date(),
      },
      select: userSelect,
    });
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
