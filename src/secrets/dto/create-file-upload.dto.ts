import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const mimeTypeMaxLength = 127;

export class CreateFileUploadDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({
    maxLength: mimeTypeMaxLength,
    default: 'application/octet-stream',
  })
  @IsOptional()
  @IsString()
  @MaxLength(mimeTypeMaxLength)
  contentType?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50 * 1024 * 1024,
    type: 'integer',
    description: 'File size in bytes; the API validation limit is 50 MiB.',
  })
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  sizeBytes!: number;
}
