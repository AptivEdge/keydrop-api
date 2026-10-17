import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SignUpDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 320, format: 'email' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 256, format: 'password' })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;
}

export class LoginDto extends SignUpDto {}

export class VerifyEmailDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 320, format: 'email' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: '123456', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 320, format: 'email' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ maxLength: 4096 })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  accessToken?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 320, format: 'email' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class ResetPasswordDto extends VerifyEmailDto {
  @ApiProperty({ minLength: 8, maxLength: 256, format: 'password' })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  newPassword!: string;
}
