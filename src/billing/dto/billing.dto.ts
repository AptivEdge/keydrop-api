import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckoutDto {
  @ApiProperty({ enum: ['pro', 'team'] })
  @IsEnum(['pro', 'team'])
  plan!: 'pro' | 'team';

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';
}

export class VerifyCheckoutDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  subscriptionId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  paymentId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  signature!: string;
}

export class ChangePlanDto {
  @ApiProperty({ enum: ['pro', 'team'] })
  @IsEnum(['pro', 'team'])
  plan!: 'pro' | 'team';

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';
}

export class RefundDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  paymentId!: string;

  @ApiPropertyOptional({
    minimum: 1,
    type: 'integer',
    description: 'Amount in the smallest currency unit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}
