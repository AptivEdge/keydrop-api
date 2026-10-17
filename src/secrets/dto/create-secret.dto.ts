import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSecretDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 65536,
    description: 'Encrypted secret storage reference.',
  })
  @IsString()
  @MaxLength(65536)
  ciphertextRef!: string;

  @ApiProperty({ minLength: 1, maxLength: 512 })
  @IsString()
  @MaxLength(512)
  iv!: string;

  @ApiProperty({ minLength: 1, maxLength: 65536 })
  @IsString()
  @MaxLength(65536)
  wrappedKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 512 })
  @IsString()
  @MaxLength(512)
  salt!: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  authHash?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    type: 'integer',
    description:
      'Maximum views are additionally limited by the account plan (3 for anonymous secrets).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxViews?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Hashed recipient email used to restrict access.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  recipientEmailHash?: string;
}
