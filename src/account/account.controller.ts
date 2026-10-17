import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../common/auth/guards/cognito-auth.guard.js';
import { AccountService } from './account.service.js';
import { CreateApiKeyDto } from './dto/api-key.dto.js';
import { CursorPaginationDto } from '../common/dto/cursor-pagination.dto.js';
import { NotificationPreferencesDto } from './dto/notification-preferences.dto.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth('cognito')
@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('entitlements')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'Get plan entitlements' })
  @ApiResponse({
    status: 200,
    description:
      'Returns the user plan and usage limits and feature availability.',
    schema: {
      type: 'object',
      required: ['plan', 'limits'],
      properties: {
        plan: { type: 'string', enum: ['free', 'pro', 'team'] },
        limits: {
          type: 'object',
          required: [
            'maxTextBytes',
            'maxViews',
            'historyDays',
            'files',
            'api',
            'audit',
            'teams',
          ],
          properties: {
            maxTextBytes: { type: 'integer' },
            maxViews: { type: 'integer' },
            historyDays: { type: 'integer' },
            files: { type: 'boolean' },
            api: { type: 'boolean' },
            audit: { type: 'boolean' },
            teams: { type: 'boolean' },
          },
        },
      },
    },
  })
  entitlements(@CurrentUser() user: AuthenticatedUser) {
    return this.account.entitlements(user.userId);
  }

  @Get('stats')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'Get secret usage statistics' })
  @ApiResponse({
    status: 200,
    description: 'Returns total, active, viewed, and revoked secret counts.',
    schema: {
      type: 'object',
      required: ['total', 'active', 'viewed', 'revoked'],
      properties: {
        total: { type: 'integer' },
        active: { type: 'integer' },
        viewed: { type: 'integer' },
        revoked: { type: 'integer' },
      },
    },
  })
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.account.stats(user.userId);
  }

  @Get('secrets')
  @RequireApiKeyScope('secrets:read')
  @ApiOperation({ summary: 'List the authenticated user secrets' })
  @ApiResponse({
    status: 200,
    description: 'Returns a cursor-paginated page of secrets, newest first.',
    schema: cursorPageSchema(secretSummarySchema()),
  })
  secrets(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.account.listSecrets(user.userId, query.cursor, query.limit);
  }

  @Get('secrets/:id')
  @RequireApiKeyScope('secrets:read')
  @ApiOperation({ summary: 'Get an owned secret summary' })
  @ApiResponse({
    status: 200,
    description: 'Returns the secret summary.',
    schema: secretSummarySchema(),
  })
  secret(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.account.getSecret(user.userId, id);
  }

  @Get('secrets/:id/events')
  @RequireApiKeyScope('secrets:read')
  @ApiOperation({ summary: 'List events for an owned secret' })
  @ApiResponse({
    status: 200,
    description:
      'Returns cursor-paginated secret events within plan retention.',
    schema: cursorPageSchema({
      type: 'object',
      properties: {
        id: { type: 'string' },
        eventType: { type: 'string' },
        actorId: { type: 'string', nullable: true },
        ipRegion: { type: 'string', nullable: true },
        device: { type: 'string', nullable: true },
        timestamp: { type: 'string', format: 'date-time' },
      },
    }),
  })
  secretEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: CursorPaginationDto,
  ) {
    return this.account.getSecretEvents(
      user.userId,
      id,
      query.cursor,
      query.limit,
    );
  }

  @Delete('secrets/:id')
  @RequireApiKeyScope('secrets:write')
  @ApiOperation({ summary: 'Delete a terminal secret' })
  @ApiResponse({
    status: 200,
    description: 'Secret deleted; no response body.',
  })
  deleteSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.account.deleteTerminalSecret(user.userId, id);
  }

  @Get('audit')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'List the authenticated user audit history' })
  @ApiResponse({
    status: 200,
    description:
      'Returns retained audit events, newest first, with a next cursor. Requires a Pro or Team plan.',
    schema: cursorPageSchema({ type: 'object', additionalProperties: true }),
  })
  audit(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.account.audit(user.userId, query.cursor, query.limit);
  }

  @Post('api-keys')
  @RateLimit('api_key_request')
  @ApiOperation({ summary: 'Create an API key' })
  @ApiResponse({
    status: 201,
    description:
      'Returns the API key once, alongside its metadata. Requires a Pro or Team plan.',
    schema: {
      type: 'object',
      required: ['id', 'name', 'scopes', 'expiresAt', 'createdAt', 'key'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        key: {
          type: 'string',
          description: 'Plaintext key; only returned at creation.',
        },
      },
    },
  })
  createApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateApiKeyDto,
  ) {
    return this.account.createApiKey(
      user.userId,
      body.name,
      body.expiresAt,
      body.scopes,
    );
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List API keys' })
  @ApiResponse({
    status: 200,
    description:
      'Returns API key metadata without plaintext keys. Requires a Pro or Team plan.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'name',
          'scopes',
          'lastUsedAt',
          'expiresAt',
          'revokedAt',
          'createdAt',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  })
  apiKeys(@CurrentUser() user: AuthenticatedUser) {
    return this.account.listApiKeys(user.userId);
  }

  @Delete('api-keys/:id')
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({
    status: 200,
    description: 'API key revoked; no response body.',
  })
  revokeApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.account.revokeApiKey(user.userId, id);
  }

  @Get('notifications')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'List notifications' })
  @ApiResponse({
    status: 200,
    description:
      'Returns a cursor-paginated page of notifications, newest first.',
    schema: cursorPageSchema({
      type: 'object',
      required: ['id', 'secretId', 'type', 'payload', 'readAt', 'createdAt'],
      properties: {
        id: { type: 'string' },
        secretId: { type: 'string', nullable: true },
        type: { type: 'string' },
        payload: {},
        readAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    }),
  })
  notifications(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.account.listNotifications(
      user.userId,
      query.cursor,
      query.limit,
    );
  }

  @Get('notification-preferences')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'Get notification delivery preferences' })
  notificationPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.account.getNotificationPreferences(user.userId);
  }

  @Patch('notification-preferences')
  @RequireApiKeyScope('account:write')
  @ApiOperation({ summary: 'Update notification delivery preferences' })
  updateNotificationPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: NotificationPreferencesDto,
  ) {
    return this.account.updateNotificationPreferences(user.userId, body);
  }

  @Get('export')
  @RequireApiKeyScope('account:read')
  @ApiOperation({ summary: 'Export account data as JSON' })
  @ApiResponse({
    status: 200,
    description:
      'Returns account data and short-lived download URLs for active encrypted objects.',
  })
  exportAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.account.exportAccount(user.userId);
  }

  @Delete('account')
  @ApiOperation({ summary: 'Delete the authenticated account' })
  @ApiResponse({
    status: 200,
    description:
      'Deletes the Cognito identity and account-owned data. Billing records are retained with an anonymized account record.',
  })
  deleteAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.account.deleteAccount(user.userId, user.username);
  }

  @Patch('notifications/:id/read')
  @RequireApiKeyScope('account:write')
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiResponse({
    status: 200,
    description: 'Notification marked as read; no response body.',
  })
  markNotificationRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.account.markNotificationRead(user.userId, id);
  }

  @Post('notifications/read-all')
  @RequireApiKeyScope('account:write')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({
    status: 201,
    description: 'Returns the number of notifications updated.',
    schema: {
      type: 'object',
      required: ['updated'],
      properties: { updated: { type: 'integer' } },
    },
  })
  markAllNotificationsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.account.markAllNotificationsRead(user.userId);
  }
}

function secretSummarySchema() {
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

function cursorPageSchema(item: Record<string, unknown>) {
  return {
    type: 'object',
    required: ['items', 'nextCursor'],
    properties: {
      items: { type: 'array', items: item },
      nextCursor: { type: 'string', nullable: true },
    },
  };
}
