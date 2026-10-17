import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthRoles } from '../../common/auth/decorators/auth.decorator.js';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator.js';
import { SelfOrStaff } from '../decorators/self-or-staff.decorator.js';
import { SelfOrStaffGuard } from '../guards/self-or-staff.guard.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateMeDto, UpdateUserDto } from '../dto/update-user.dto.js';
import { UsersService } from './users.service.js';
import type { AuthenticatedUser } from '../../common/auth/guards/cognito-auth.guard.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth('cognito')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'List users (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Returns users ordered by creation time, newest first.',
    schema: { type: 'array', items: userSchema() },
  })
  findAll() {
    return this.users.findAll();
  }

  @Post()
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Create a user (admin only)' })
  @ApiResponse({
    status: 201,
    description: 'Returns the created user.',
    schema: userSchema(),
  })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'Returns the authenticated user.',
    schema: userSchema(),
  })
  findMe(@CurrentUser() user: AuthenticatedUser) {
    return this.users.findById(user.userId);
  }

  @Get(':id')
  @SelfOrStaff()
  @UseGuards(SelfOrStaffGuard)
  @ApiOperation({ summary: 'Get a user by ID (self or staff)' })
  @ApiResponse({
    status: 200,
    description: 'Returns the requested user.',
    schema: userSchema(),
  })
  findOne(@Param('id') id: string) {
    return this.users.findById(id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the authenticated user email' })
  @ApiResponse({
    status: 200,
    description: 'Returns the updated user.',
    schema: userSchema(),
  })
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateMeDto) {
    return this.users.update(user.userId, { email: dto.email });
  }

  @Patch(':id')
  @AuthRoles('ADM')
  @SelfOrStaff()
  @UseGuards(SelfOrStaffGuard)
  @ApiOperation({ summary: 'Update a user (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Returns the updated user.',
    schema: userSchema(),
  })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  @AuthRoles('ADM')
  @ApiOperation({ summary: 'Delete a user (admin only)' })
  @ApiResponse({ status: 200, description: 'User deleted; no response body.' })
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}

function userSchema() {
  return {
    type: 'object' as const,
    required: [
      'id',
      'email',
      'cognitoSubject',
      'plan',
      'emailVerifiedAt',
      'createdAt',
      'updatedAt',
      'adminUser',
    ],
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      cognitoSubject: { type: 'string' },
      plan: { type: 'string', enum: ['free', 'pro', 'team'] },
      emailVerifiedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      adminUser: {
        type: 'object',
        nullable: true,
        properties: { role: { type: 'string' } },
      },
    },
  };
}
