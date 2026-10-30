import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import { Public } from '../common/auth/decorators/public.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import { CursorPaginationDto } from '../common/dto/cursor-pagination.dto.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import { CreateSecretRequestLinkDto } from './dto/create-secret-request-link.dto.js';
import { RespondToSecretRequestDto } from './dto/respond-to-secret-request.dto.js';
import { RequestsService } from './requests.service.js';

const idPattern = /^[A-Za-z0-9]{22}$/;

@ApiTags('Requests')
@Controller('requests')
export class PublicRequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Public()
  @Get(':id/meta')
  @ApiOperation({ summary: 'Get public secret request instructions and ECDH key' })
  @ApiResponse({
    status: 200,
    description: 'Returns request instructions and the requester public key.',
  })
  meta(@Param('id') id: string) {
    assertRequestId(id);
    return this.requests.getPublicMeta(id);
  }

  @Public()
  @Post(':id/respond')
  @RateLimit('request_respond')
  @ApiOperation({ summary: 'Submit a client-encrypted response to a request' })
  @ApiResponse({
    status: 201,
    description: 'The request was fulfilled; only an encrypted response is stored.',
  })
  respond(
    @Param('id') id: string,
    @Body() dto: RespondToSecretRequestDto,
  ) {
    assertRequestId(id);
    return this.requests.respond(id, dto);
  }
}

@ApiTags('Requests')
@ApiBearerAuth('supabase')
@Controller('me/requests')
export class AccountRequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  @RequireApiKeyScope('account:write')
  @RateLimit('request_create')
  @ApiOperation({ summary: 'Create a Pro secret request' })
  @ApiResponse({
    status: 201,
    description: 'Returns the request metadata and optional email-delivery status.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSecretRequestLinkDto,
  ) {
    return this.requests.create(user.userId, dto);
  }

  @Get()
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'List secret requests owned by the account' })
  @ApiResponse({
    status: 200,
    description: 'Returns cursor-paginated request metadata.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.requests.list(user.userId, query.cursor, query.limit);
  }

  @Get(':id')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'Get an owned request and its encrypted response' })
  @ApiResponse({
    status: 200,
    description: 'Returns the request and ciphertext envelope, if fulfilled.',
  })
  getOwned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    assertRequestId(id);
    return this.requests.getOwned(user.userId, id);
  }

  @Post(':id/cancel')
  @RequireApiKeyScope('account:write')
  @ApiOperation({ summary: 'Cancel a pending secret request' })
  @ApiResponse({ status: 201, description: 'The request was cancelled.' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    assertRequestId(id);
    return this.requests.cancel(user.userId, id);
  }
}

function assertRequestId(id: string): void {
  if (!idPattern.test(id)) throw new NotFoundException('Request not found');
}
