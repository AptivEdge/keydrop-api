import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../common/auth/decorators/public.decorator.js';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/cognito-auth.guard.js';
import { CreateSecretDto } from './dto/create-secret.dto.js';
import { RevealSecretDto } from './dto/reveal-secret.dto.js';
import { ReportSecretDto } from './dto/report-secret.dto.js';
import { CreateSecretRequestDto } from './dto/create-secret-request.dto.js';
import { UpdateSecretRequestDto } from './dto/update-secret-request.dto.js';
import { CreateFileUploadDto } from './dto/create-file-upload.dto.js';
import { RequestRecipientAccessDto } from './dto/request-recipient-access.dto.js';
import { SecretsService } from './secrets.service.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import { RecipientAccessService } from './recipient-access.service.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import {
  ApiBearerAuth,
  ApiBody,
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
  @RequireApiKeyScope('secrets:write')
  @RateLimit('secret_create')
  @ApiBearerAuth('cognito')
  @ApiOperation({ summary: 'Create an authenticated secret' })
  @ApiResponse({
    status: 201,
    description: 'Returns the created secret metadata.',
    schema: secretMetadataSchema(),
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSecretDto) {
    return this.secrets.create(user, dto);
  }

  @Public()
  @Post('anonymous')
  @RateLimit('anonymous_secret_create')
  @ApiBody({ schema: anonymousSecretBodySchema() })
  @ApiOperation({ summary: 'Create an anonymous secret' })
  @ApiResponse({
    status: 201,
    description: 'Returns the created secret metadata.',
    schema: secretMetadataSchema(),
  })
  createAnonymous(@Body() dto: CreateSecretDto) {
    return this.secrets.createAnonymous(dto);
  }

  @Public()
  @Get(':id/meta')
  @ApiOperation({ summary: 'Get public secret metadata' })
  @ApiResponse({
    status: 200,
    description:
      'Returns public metadata and whether a passphrase is required.',
    schema: {
      ...secretMetadataSchema(),
      properties: {
        ...secretMetadataSchema().properties,
        requiresPassphrase: { type: 'boolean' },
      },
    },
  })
  getMeta(@Param('id') id: string) {
    return this.secrets.getMeta(id);
  }

  @Public()
  @Post(':id/access/request')
  @RateLimit('recipient_access')
  @ApiOperation({ summary: 'Request recipient access to a secret' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the access request identifier, status, and creation time.',
    schema: accessRequestSchema(),
  })
  requestRecipientAccess(
    @Param('id') id: string,
    @Body() dto: RequestRecipientAccessDto,
  ) {
    return this.recipientAccess.requestAccess(id, dto.email);
  }

  @Public()
  @Post(':id/reveal')
  @RateLimit('secret_reveal')
  @ApiOperation({ summary: 'Reveal a secret' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the encrypted secret material. The client decrypts it.',
    schema: {
      type: 'object',
      required: ['ciphertextRef', 'iv', 'wrappedKey', 'salt'],
      properties: {
        ciphertextRef: { type: 'string' },
        iv: { type: 'string' },
        wrappedKey: { type: 'string' },
        salt: { type: 'string' },
      },
    },
  })
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
  @ApiBearerAuth('cognito')
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
  @ApiBearerAuth('cognito')
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
  @ApiBearerAuth('cognito')
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
  @ApiBearerAuth('cognito')
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
  @ApiBearerAuth('cognito')
  @ApiOperation({ summary: 'Verify that a file upload completed' })
  @ApiResponse({
    status: 201,
    description:
      'Verifies the S3 object size and content type before completion.',
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
  @ApiBearerAuth('cognito')
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
    required: [
      'id',
      'label',
      'status',
      'maxViews',
      'viewsUsed',
      'expiresAt',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      label: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: ['active', 'viewed', 'expired', 'revoked'],
      },
      maxViews: { type: 'integer', nullable: true },
      viewsUsed: { type: 'integer' },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
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

function anonymousSecretBodySchema() {
  return {
    type: 'object' as const,
    required: ['ciphertextRef', 'iv', 'wrappedKey', 'salt', 'expiresAt'],
    properties: {
      ciphertextRef: { type: 'string', minLength: 1, maxLength: 65536 },
      iv: { type: 'string', minLength: 1, maxLength: 512 },
      wrappedKey: { type: 'string', minLength: 1, maxLength: 8192 },
      salt: { type: 'string', minLength: 1, maxLength: 512 },
      authHash: { type: 'string', maxLength: 512 },
      label: { type: 'string', maxLength: 200 },
      maxViews: { type: 'integer', minimum: 1, maximum: 3 },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        description: 'Must expire within 24 hours.',
      },
      recipientEmailHash: { type: 'string', maxLength: 512 },
    },
  };
}
