import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateAdminDataRequestDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  userId!: string;

  @ApiProperty({ enum: ['export', 'deletion'] })
  @IsIn(['export', 'deletion'])
  kind!: 'export' | 'deletion';

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiProperty()
  @IsDateString()
  dueAt!: string;
}

export class UpdateAdminDataRequestDto {
  @ApiProperty({ enum: ['received', 'verifying', 'processing', 'completed', 'rejected'] })
  @IsIn(['received', 'verifying', 'processing', 'completed', 'rejected'])
  status!: 'received' | 'verifying' | 'processing' | 'completed' | 'rejected';

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  staffNote?: string;
}

export class CreateAdminBlocklistEntryDto {
  @ApiProperty({ enum: ['account', 'email_domain'] })
  @IsIn(['account', 'email_domain'])
  kind!: 'account' | 'email_domain';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  value!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
