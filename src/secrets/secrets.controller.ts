import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Public } from '../common/auth/decorators/public.decorator.js';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/supabase-auth.guard.js';
import { CreateSecretDto } from './dto/create-secret.dto.js';
import { RevealSecretDto } from './dto/reveal-secret.dto.js';
import { ReportSecretDto } from './dto/report-secret.dto.js';
import { CreateSecretRequestDto } from './dto/create-secret-request.dto.js';
import { UpdateSecretRequestDto } from './dto/update-secret-request.dto.js';
import { CreateFileUploadDto } from './dto/create-file-upload.dto.js';
import { VerifyRecipientCodeDto } from './dto/verify-recipient-code.dto.js';
import { SecretsService } from './secrets.service.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import { RecipientAccessService } from './recipient-access.service.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import { OptionalAuth } from '../common/auth/decorators/optional-auth.decorator.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Secrets')
@Controller('secrets')
export class SecretsController {
  constructor(
    private readonly secrets: SecretsService,
    private readonly recipientAccess: RecipientAccessService,
  ) {}

  @Post()
  @OptionalAuth()
  @RequireApiKeyScope('secrets:write')
  @RateLimit('secret_create')
  @ApiOperation({
    summary: 'Create a secret on an active Pro or Team subscription',
    security: [{ supabase: [] }, {}],
  })
  @ApiResponse({
    status: 201,
    description: 'Returns the public id and secret settings.',
    schema: secretMetadataSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Secret creation requires an active Pro or Team subscription.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() dto: CreateSecretDto,
  ) {
    return user
      ? this.secrets.create(user, dto)
      : this.secrets.createAnonymous();
  }

  @Public()
  @Post('anonymous')
  @RateLimit('anonymous_secret_create')
  @ApiOperation({
    summary: 'Disabled: anonymous secret creation is unavailable',
  })
  @ApiResponse({
    status: 403,
    description: 'Anonymous secret creation is unavailable.',
  })
  createAnonymous() {
    return this.secrets.createAnonymous();
  }

  @Public()
  @Get(':id/meta')
  @ApiOperation({ summary: 'Get public secret metadata' })
  @ApiResponse({
    status: 200,
    description:
      'Returns public metadata and required recipient verification steps.',
    schema: {
      ...secretMetadataSchema(),
      properties: {
        ...secretMetadataSchema().properties,
        requires_passphrase: { type: 'boolean' },
        requires_email_verification: { type: 'boolean' },
        kdf: {
          type: 'object',
          additionalProperties: true,
          description:
            'Public key-derivation parameters required by the recipient.',
        },
      },
    },
  })
  getMeta(@Param('id') id: string) {
    return this.secrets.getMeta(id);
  }

  @Public()
  @Post(':id/email-code')
  @RateLimit('recipient_access')
  @ApiOperation({ summary: 'Email the recipient verification code' })
  @ApiResponse({
    status: 201,
    description: 'A six-digit verification code was sent to the recipient.',
  })
  sendRecipientCode(@Param('id') id: string) {
    return this.recipientAccess.sendCode(id);
  }

  @Public()
  @Post(':id/email-verify')
  @RateLimit('otp_verify')
  @ApiOperation({
    summary: 'Verify the recipient code and issue an access token',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a five-minute access token bound to this secret.',
    schema: {
      type: 'object',
      required: ['access_token', 'expires_in'],
      properties: {
        access_token: { type: 'string' },
        expires_in: { type: 'integer', example: 300 },
      },
    },
  })
  @HttpCode(HttpStatus.OK)
  verifyRecipientCode(
    @Param('id') id: string,
    @Body() dto: VerifyRecipientCodeDto,
  ) {
    return this.recipientAccess.verifyCode(id, dto.code);
  }

  @Public()
  @Post(':id/reveal')
  @RateLimit('secret_reveal')
  @ApiOperation({ summary: 'Reveal a secret' })
  @ApiResponse({
    status: 200,
    description:
      'Returns the encrypted secret material. The client decrypts it.',
    schema: {
      ...encryptedMaterialSchema(),
    },
  })
  @HttpCode(HttpStatus.OK)
  reveal(@Param('id') id: string, @Body() dto: RevealSecretDto) {
    return this.secrets.reveal(id, dto);
  }

  @Public()
  @Post(':id/report')
  @RateLimit('secret_report')
  @ApiOperation({ summary: 'Report a secret for abuse' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the created report identifier, status, and creation time.',
    schema: {
      type: 'object',
      required: ['id', 'status', 'createdAt'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  report(
    @Param('id') id: string,
    @Body() dto: ReportSecretDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.secrets.report(id, dto, user?.userId);
  }

  @Post(':id/revoke')
  @RequireApiKeyScope('secrets:write')
  @ApiBearerAuth('supabase')
  @ApiOperation({ summary: 'Revoke an owned secret' })
  @ApiResponse({
    status: 201,
    description: 'Secret revoked; no response body.',
  })
  revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.secrets.revoke(id, user);
  }

  @Public()
  @Post(':id/requests')
  @ApiOperation({ summary: 'Create a secret access request' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the access request identifier, status, and creation time.',
    schema: accessRequestSchema(),
  })
  createRequest(@Param('id') id: string, @Body() dto: CreateSecretRequestDto) {
    return this.secrets.createRequest(id, dto);
  }

  @Get(':id/requests')
  @RequireApiKeyScope('secrets:read')
  @ApiBearerAuth('supabase')
  @ApiOperation({ summary: 'List access requests for an owned secret' })
  @ApiResponse({
    status: 200,
    description:
      'Returns access requests ordered by creation time, newest first.',
    schema: { type: 'array', items: accessRequestListItemSchema() },
  })
  listRequests(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.secrets.listRequests(id, user.userId);
  }

  @Post(':id/requests/:requestId')
  @RequireApiKeyScope('secrets:write')
  @ApiBearerAuth('supabase')
  @ApiOperation({ summary: 'Approve or deny an access request' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the updated request identifier, status, and update time.',
    schema: {
      type: 'object',
      required: ['id', 'status', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['approved', 'denied'] },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  updateRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: UpdateSecretRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.secrets.updateRequest(id, requestId, user.userId, dto);
  }

  @Post(':id/files')
  @RequireApiKeyScope('secrets:write')
  @ApiBearerAuth('supabase')
  @ApiOperation({ summary: 'Create a presigned file upload URL' })
  @ApiResponse({
    status: 201,
    description:
      'Returns file metadata, an upload URL valid for 900 seconds, and its expiry duration.',
    schema: {
      type: 'object',
      required: [
        'id',
        'filename',
        'contentType',
        'sizeBytes',
        'createdAt',
        'uploadUrl',
        'expiresIn',
      ],
      properties: {
        id: { type: 'string' },
        filename: { type: 'string' },
        contentType: { type: 'string' },
        sizeBytes: { type: 'integer' },
        createdAt: { type: 'string', format: 'date-time' },
        uploadUrl: { type: 'string', format: 'uri' },
        expiresIn: { type: 'integer', example: 900 },
      },
    },
  })
  createFileUpload(
    @Param('id') id: string,
    @Body() dto: CreateFileUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.secrets.createFileUpload(id, user.userId, dto);
  }

  @Post(':id/files/:fileId/complete')
  @RequireApiKeyScope('secrets:write')
  @ApiBearerAuth('supabase')
  @ApiOperation({ summary: 'Verify that a file upload completed' })
  @ApiResponse({
    status: 201,
    description:
      'Verifies the stored object size and content type before completion.',
    schema: {
      type: 'object',
      required: ['id', 'uploaded', 'alreadyCompleted'],
      properties: {
        id: { type: 'string' },
        uploaded: { type: 'boolean' },
        alreadyCompleted: { type: 'boolean' },
      },
    },
  })
  completeFileUpload(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.secrets.completeFileUpload(id, fileId, user.userId);
  }

  @Get(':id/files/:fileId/download')
  @RequireApiKeyScope('secrets:read')
  @ApiBearerAuth('supabase')
  @ApiOperation({
    summary: 'Get a presigned download URL for an uploaded file',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a download URL valid for 900 seconds.',
    schema: {
      type: 'object',
      required: ['id', 'downloadUrl', 'expiresIn'],
      properties: {
        id: { type: 'string' },
        downloadUrl: { type: 'string', format: 'uri' },
        expiresIn: { type: 'integer', example: 900 },
      },
    },
  })
  downloadFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.secrets.getFileDownloadUrl(id, fileId, user.userId);
  }
}

function secretMetadataSchema() {
  return {
    type: 'object' as const,
    required: ['id', 'status', 'expires_at', 'max_views'],
    properties: {
      id: { type: 'string' },
      label: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: [
          'active',
          'partially_viewed',
          'viewed',
          'expired',
          'revoked',
          'locked',
        ],
      },
      max_views: { type: 'integer', nullable: true },
      expires_at: { type: 'string', format: 'date-time', nullable: true },
    },
  };
}

function encryptedMaterialSchema() {
  return {
    type: 'object' as const,
    required: ['ciphertext', 'iv', 'kdf'],
    properties: {
      ciphertext: { type: 'string' },
      iv: { type: 'string' },
      kdf: {
        type: 'object',
        required: ['algorithm'],
        properties: {
          algorithm: { type: 'string', enum: ['HKDF-SHA-256', 'Argon2id'] },
          salt: { type: 'string' },
          parameters: { type: 'object', additionalProperties: true },
        },
      },
    },
  };
}

function accessRequestSchema() {
  return {
    type: 'object' as const,
    required: ['id', 'status', 'createdAt'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'approved', 'denied'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function accessRequestListItemSchema() {
  const schema = accessRequestSchema();
  return {
    ...schema,
    required: [...schema.required, 'updatedAt'],
    properties: {
      ...schema.properties,
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}
