import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RevealSecretDto {
  @ApiPropertyOptional({
    maxLength: 4096,
    description: 'Recipient access token when recipient access is enabled.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  accessToken?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Secret passphrase when passphrase protection is enabled.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  auth?: string;
}
