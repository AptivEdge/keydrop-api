import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateSecretRequestLinkDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiProperty({ minLength: 1, maxLength: 3000 })
  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  instructions!: string;

  @ApiProperty({
    maxLength: 128,
    description: 'Base64url-encoded raw ECDH P-256 public key.',
  })
  @IsString()
  @MaxLength(128)
  public_key!: string;

  @ApiProperty({ type: 'integer', minimum: 60, maximum: 2592000 })
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
