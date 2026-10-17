import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSecretRequestDto {
  @ApiProperty({ enum: ['approved', 'denied'] })
  @IsEnum(['approved', 'denied'])
  status!: 'approved' | 'denied';
}
