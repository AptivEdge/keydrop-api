import {
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class KdfDto {
  @ApiProperty({ enum: ['HKDF-SHA-256', 'Argon2id'] })
  @IsIn(['HKDF-SHA-256', 'Argon2id'])
  algorithm!: 'HKDF-SHA-256' | 'Argon2id';

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  salt?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { m: 65536, t: 3, p: 1 },
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, number>;
}

export class CreateSecretDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 350000,
    description: 'Base64url-encoded ciphertext produced by the client.',
  })
  @IsString()
  @MaxLength(350000)
  ciphertext!: string;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MaxLength(64)
  iv!: string;

  @ApiProperty({ type: KdfDto })
  @ValidateNested()
  @Type(() => KdfDto)
  kdf!: KdfDto;

  @ApiPropertyOptional({
    maxLength: 128,
    description: 'Client-derived auth value; the passphrase is never sent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  auth?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    type: 'integer',
    description: 'Maximum views are enforced by the account plan.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  max_views?: number;

  @ApiProperty({
    type: 'integer',
    minimum: 60,
    maximum: 2592000,
    description: 'Expiry duration in seconds; enforced by the account plan.',
  })
  @IsInt()
  @Min(60)
  @Max(2592000)
  expires_in!: number;

  @ApiPropertyOptional({ format: 'email', maxLength: 320 })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  recipient_email?: string;
}
