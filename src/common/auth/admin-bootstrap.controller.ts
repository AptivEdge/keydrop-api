import {
  Body,
  Controller,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto.js';
import { Public } from './decorators/public.decorator.js';
import { AuthService } from './services/auth.service.js';

@Public()
@ApiTags('Admin')
@Controller('admin/bootstrap')
export class AdminBootstrapController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @RateLimit('admin_bootstrap')
  @ApiOperation({
    summary:
      'Bootstrap the first ADM account with a one-time deployment secret',
  })
  @ApiHeader({
    name: 'x-admin-bootstrap-token',
    required: true,
    description:
      'Temporary high-entropy token configured only during bootstrap.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Creates the first ADM with the supplied initial password and sends email verification.',
  })
  create(
    @Body() dto: BootstrapAdminDto,
    @Headers('x-admin-bootstrap-token') suppliedToken?: string,
  ) {
    const expectedToken = this.config
      .get<string>('ADMIN_BOOTSTRAP_TOKEN')
      ?.trim();
    if (!expectedToken) {
      throw new ServiceUnavailableException(
        'First-admin bootstrap is disabled',
      );
    }

    const expected = Buffer.from(expectedToken, 'utf8');
    if (expected.length < 32) {
      throw new ServiceUnavailableException(
        'First-admin bootstrap is not securely configured',
      );
    }

    const supplied = Buffer.from(suppliedToken ?? '', 'utf8');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException('Invalid bootstrap token');
    }

    return this.auth.createFirstAdminAccount(dto.email, dto.password);
  }
}
