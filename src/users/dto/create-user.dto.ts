import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 320, format: 'email' })
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  identitySubject: string;

  @ApiPropertyOptional({ enum: ['free', 'pro', 'team'], default: 'free' })
  @IsOptional()
  @IsEnum(['free', 'pro', 'team'])
  plan?: 'free' | 'pro' | 'team';
}
