import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';

class NotificationChannelPreferenceDto {
  @ApiPropertyOptional()
  @IsBoolean()
  inApp!: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  email!: boolean;
}

export class NotificationPreferencesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  secret_created?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  secret_viewed?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  secret_expiring?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  secret_expired?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  access_requested?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  access_granted?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  access_denied?: NotificationChannelPreferenceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationChannelPreferenceDto)
  billing_payment_failed?: NotificationChannelPreferenceDto;
}
