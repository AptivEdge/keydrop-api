import {
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TeamNameDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class TeamInvitationDto {
  @ApiProperty({
    example: 'member@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiPropertyOptional({ enum: ['admin', 'member'], default: 'member' })
  @IsOptional()
  @IsEnum(['admin', 'member'])
  role?: 'admin' | 'member';
}

export class TeamPolicyDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  rules!: Record<string, unknown>;
}

export class TeamMemberRoleDto {
  @ApiProperty({ enum: ['admin', 'member'] })
  @IsEnum(['admin', 'member'])
  role!: 'admin' | 'member';
}

export class AcceptInvitationDto {
  @ApiProperty({ minLength: 1, maxLength: 512 })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;
}
