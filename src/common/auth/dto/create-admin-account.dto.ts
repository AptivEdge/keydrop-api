import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class CreateAdminAccountDto {
  @ApiProperty({
    example: 'admin@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsEmail()
  @MaxLength(320)
  email: string;
}
