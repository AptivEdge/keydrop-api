import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  API_KEY_SCOPES,
  ApiKeyScope,
} from '../../common/auth/api-key-scopes.js';

export class CreateApiKeyDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Must be a future timestamp.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    type: [String],
    enum: API_KEY_SCOPES,
    description:
      'Defaults to secrets:read. Scopes grant specific route permissions.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(API_KEY_SCOPES.length)
  @ArrayUnique()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes?: ApiKeyScope[];
}
