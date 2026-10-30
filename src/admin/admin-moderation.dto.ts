import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAbuseReportDto {
  @ApiPropertyOptional({ enum: ['pending', 'reviewing', 'resolved', 'dismissed'] })
  @IsOptional()
  @IsIn(['pending', 'reviewing', 'resolved', 'dismissed'])
  status?: 'pending' | 'reviewing' | 'resolved' | 'dismissed';

  @ApiPropertyOptional({ enum: ['low', 'normal', 'high', 'critical'] })
  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'critical'])
  severity?: 'low' | 'normal' | 'high' | 'critical';

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  assigneeId?: string | null;

  @ApiPropertyOptional({ minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNote?: string;
}

export class CreateAdminApprovalDto {
  @IsString()
  @MaxLength(128)
  action!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  targetType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  targetId!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @IsObject()
  details!: Record<string, unknown>;
}

export class ReviewAdminApprovalDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}

export class ModerateAdminEntityDto {
  @IsIn([
    'note',
    'warn',
    'suspend',
    'unsuspend',
    'revoke_access',
    'remove_member',
    'delete',
  ])
  action!: 'note' | 'warn' | 'suspend' | 'unsuspend' | 'revoke_access' | 'remove_member' | 'delete';

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  memberId?: string;
}
