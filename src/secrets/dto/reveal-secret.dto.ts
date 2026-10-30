import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RevealSecretDto {
  @ApiPropertyOptional({
    maxLength: 4096,
    description: 'Recipient access token returned by email-code verification.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  access_token?: string;

  @ApiPropertyOptional({
    maxLength: 128,
    description:
      'Client-derived auth value when passphrase protection is enabled.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  auth?: string;
}
