import { IsEmail, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'user@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ enum: ['free', 'pro', 'team'] })
  @IsOptional()
  @IsEnum(['free', 'pro', 'team'])
  plan?: 'free' | 'pro' | 'team';
}

export class UpdateMeDto {
  @ApiPropertyOptional({
    example: 'user@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
