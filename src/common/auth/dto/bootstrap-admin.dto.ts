import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class BootstrapAdminDto {
  @ApiProperty({
    example: 'admin@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    minLength: 12,
    maxLength: 256,
    format: 'password',
    description: 'Initial password selected by the first admin.',
  })
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;
}
