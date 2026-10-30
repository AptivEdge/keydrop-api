import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckoutDto {
  @ApiProperty({ enum: ['pro', 'team'] })
  @IsEnum(['pro', 'team'])
  plan!: 'pro' | 'team';

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';

  @ApiPropertyOptional({
    minimum: 100,
    maximum: 100_000_000,
    description: 'Displayed price in the smallest currency unit; rejects stale pricing.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(100_000_000)
  expectedAmount?: number;
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

export class CreateAdminBillingPlanDto {
  @ApiProperty({ enum: ['pro', 'team'] })
  @IsEnum(['pro', 'team'])
  tier!: 'pro' | 'team';

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    minimum: 100,
    maximum: 100_000_000,
    description: 'Price in the smallest currency unit (paise for INR).',
  })
  @IsInt()
  @Min(100)
  @Max(100_000_000)
  amount!: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}
