import { IsEmail, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSecretRequestDto {
  @ApiProperty({
    example: 'recipient@example.com',
    maxLength: 320,
    format: 'email',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
