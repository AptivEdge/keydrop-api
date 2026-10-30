import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RespondToSecretRequestDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 350000,
    description: 'Base64url-encoded ECDH/AES-GCM ciphertext.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(350000)
  ciphertext!: string;

  @ApiProperty({ maxLength: 32, description: 'Base64url-encoded 12-byte IV.' })
  @IsString()
  @MaxLength(32)
  iv!: string;

  @ApiProperty({ maxLength: 32, description: 'Base64url-encoded HKDF salt.' })
  @IsString()
  @MaxLength(32)
  salt!: string;

  @ApiProperty({
    maxLength: 128,
    description: 'Base64url-encoded raw ephemeral ECDH P-256 public key.',
  })
  @IsString()
  @MaxLength(128)
  ephemeral_public_key!: string;
}
