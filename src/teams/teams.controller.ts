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
import { CursorPaginationDto } from '../common/dto/cursor-pagination.dto.js';
import { RequireApiKeyScope } from '../common/auth/api-key-scopes.js';
import { TeamsService } from './teams.service.js';
import {
  AcceptInvitationDto,
  TeamInvitationDto,
  TeamMemberRoleDto,
  TeamNameDto,
  TeamPolicyDto,
} from './dto/team.dto.js';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Teams')
@ApiBearerAuth('cognito')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Create a team' })
  @ApiResponse({
    status: 201,
    description: 'Returns the created team. Requires a Team plan.',
    schema: teamCreatedSchema(),
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: TeamNameDto) {
    return this.teams.create(user.userId, body.name);
  }

  @Get()
  @RequireApiKeyScope('teams:read')
  @ApiOperation({ summary: 'List teams for the authenticated user' })
  @ApiResponse({
    status: 200,
    description:
      'Returns a cursor-paginated page of teams, newest first, with the user role and member count.',
    schema: {
      type: 'object',
      required: ['items', 'nextCursor'],
      properties: {
        items: {
          type: 'array',
          items: {
            ...teamCreatedSchema(),
            required: [
              ...teamCreatedSchema().required,
              'updatedAt',
              'members',
              '_count',
            ],
            properties: {
              ...teamCreatedSchema().properties,
              updatedAt: { type: 'string', format: 'date-time' },
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { role: { type: 'string' } },
                },
              },
              _count: {
                type: 'object',
                properties: { members: { type: 'integer' } },
              },
            },
          },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorPaginationDto,
  ) {
    return this.teams.listForUser(user.userId, query.cursor, query.limit);
  }

  @Get(':id')
  @RequireApiKeyScope('teams:read')
  @ApiOperation({ summary: 'Get team details' })
  @ApiResponse({
    status: 200,
    description:
      'Returns the team and its members, including member user IDs and email addresses.',
    schema: {
      type: 'object',
      required: [
        'id',
        'name',
        'createdBy',
        'createdAt',
        'updatedAt',
        'members',
      ],
      properties: {
        ...teamCreatedSchema().properties,
        updatedAt: { type: 'string', format: 'date-time' },
        members: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'userId', 'role', 'createdAt', 'user'],
            properties: {
              id: { type: 'string' },
              userId: { type: 'string' },
              role: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              user: {
                type: 'object',
                required: ['id', 'email', 'emailVerifiedAt'],
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  emailVerifiedAt: {
                    type: 'string',
                    format: 'date-time',
                    nullable: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.teams.getForUser(user.userId, id);
  }

  @Patch(':id')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Update a team name' })
  @ApiResponse({
    status: 200,
    description: 'Returns the updated team identifier, name, and update time.',
    schema: {
      type: 'object',
      required: ['id', 'name', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: TeamNameDto,
  ) {
    return this.teams.updateName(user.userId, id, body.name);
  }

  @Post(':id/invitations')
  @RequireApiKeyScope('teams:write')
  @RateLimit('team_invitation')
  @ApiOperation({ summary: 'Invite a member to a team' })
  @ApiResponse({
    status: 201,
    description:
      'Returns invitation details. Invitation delivery is sent by email.',
    schema: {
      type: 'object',
      required: ['id', 'email', 'role', 'expiresAt'],
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
        role: { type: 'string', enum: ['admin', 'member'] },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
    @Body() body: TeamInvitationDto,
  ) {
    return this.teams.inviteMember(
      user.userId,
      teamId,
      body.email,
      body.role ?? 'member',
    );
  }

  @Get(':id/invitations')
  @RequireApiKeyScope('teams:read')
  @ApiOperation({ summary: 'List team invitations' })
  @ApiResponse({
    status: 200,
    description:
      'Returns team invitations ordered by creation time, newest first.',
    schema: { type: 'array', items: invitationSchema() },
  })
  invitations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
  ) {
    return this.teams.listInvitations(user.userId, teamId);
  }

  @Get(':id/policies')
  @RequireApiKeyScope('teams:read')
  @ApiOperation({ summary: 'List team policies' })
  @ApiResponse({
    status: 200,
    description: 'Returns team policies ordered by creation time.',
    schema: {
      type: 'array',
      items: {
        ...policySchema(),
        required: [...policySchema().required, 'createdAt'],
      },
    },
  })
  policies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
  ) {
    return this.teams.listPolicies(user.userId, teamId);
  }

  @Patch(':id/policies/:policyType')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Create or update a team policy' })
  @ApiParam({
    name: 'policyType',
    enum: [
      'secret_expiration',
      'access_control',
      'view_limit',
      'team_security',
      'retention',
      'custom',
    ],
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the created or updated team policy.',
    schema: policySchema(),
  })
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
    @Param('policyType')
    policyType:
      | 'secret_expiration'
      | 'access_control'
      | 'view_limit'
      | 'team_security'
      | 'retention'
      | 'custom',
    @Body() body: TeamPolicyDto,
  ) {
    return this.teams.upsertPolicy(user.userId, teamId, policyType, body.rules);
  }

  @Delete(':id/invitations/:invitationId')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Revoke a team invitation' })
  @ApiResponse({
    status: 200,
    description: 'Invitation revoked; no response body.',
  })
  revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.teams.revokeInvitation(user.userId, teamId, invitationId);
  }

  @Patch(':id/members/:memberId')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Update a team member role' })
  @ApiResponse({
    status: 200,
    description: 'Returns the updated team membership.',
    schema: {
      type: 'object',
      required: ['id', 'userId', 'role'],
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'member'] },
      },
    },
  })
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
    @Param('memberId') memberId: string,
    @Body() body: TeamMemberRoleDto,
  ) {
    return this.teams.updateMemberRole(
      user.userId,
      teamId,
      memberId,
      body.role,
    );
  }

  @Delete(':id/members/:memberId')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Remove a member from a team' })
  @ApiResponse({
    status: 200,
    description: 'Team member removed; no response body.',
  })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') teamId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.teams.removeMember(user.userId, teamId, memberId);
  }

  @Post('invitations/accept')
  @RequireApiKeyScope('teams:write')
  @ApiOperation({ summary: 'Accept a team invitation' })
  @ApiResponse({
    status: 201,
    description: 'Returns the team identifier and assigned role.',
    schema: {
      type: 'object',
      required: ['teamId', 'role'],
      properties: {
        teamId: { type: 'string' },
        role: { type: 'string' },
      },
    },
  })
  acceptInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AcceptInvitationDto,
  ) {
    return this.teams.acceptInvitation(user.userId, body.token);
  }
}

function teamCreatedSchema() {
  return {
    type: 'object' as const,
    required: ['id', 'name', 'createdBy', 'createdAt'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      createdBy: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function invitationSchema() {
  return {
    type: 'object' as const,
    required: [
      'id',
      'email',
      'role',
      'expiresAt',
      'acceptedAt',
      'revokedAt',
      'createdAt',
    ],
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'member'] },
      expiresAt: { type: 'string', format: 'date-time' },
      acceptedAt: { type: 'string', format: 'date-time', nullable: true },
      revokedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function policySchema() {
  return {
    type: 'object' as const,
    required: ['id', 'policyType', 'rules', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      policyType: {
        type: 'string',
        enum: [
          'secret_expiration',
          'access_control',
          'view_limit',
          'team_security',
          'retention',
          'custom',
        ],
      },
      rules: { type: 'object', additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}
