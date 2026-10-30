import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRoles } from './decorators/auth.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthenticatedUser } from './guards/supabase-auth.guard.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { CreateAdminAccountDto } from './dto/create-admin-account.dto.js';
import { AuthService } from './services/auth.service.js';
import { UsersService } from '../../users/controllers/users.service.js';

@ApiTags('Admin')
@ApiBearerAuth('supabase')
@AuthRoles('ADM')
@Controller('admin/admin-users')
export class AdminAccountsController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List staff accounts (ADM only)' })
  @ApiResponse({ status: 200, description: 'Returns assigned staff accounts.' })
  list() {
    return this.users.findAdminAccounts();
  }

  @Post()
  @RateLimit('admin_account_create')
  @ApiOperation({
    summary: 'Create an admin account and send email verification (ADM only)',
  })
  @ApiResponse({
    status: 201,
    description:
      'Creates an ADM account with a random undisclosed password and sends a verification code.',
  })
  create(
    @Body() dto: CreateAdminAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.auth.createAdminAccount(dto.email, actor.userId);
  }
}
