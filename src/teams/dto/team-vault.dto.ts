import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDefined,
  IsArray,
  IsObject,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateSecretDto } from '../../secrets/dto/create-secret.dto.js';

export class UserEncryptionKeyDto {
  @IsObject()
  @IsDefined()
  publicKey!: Record<string, unknown>;

  @IsObject()
  @IsDefined()
  encryptedPrivateKey!: Record<string, unknown>;
}

export class TeamSecretKeyEnvelopeDto {
  @IsString()
  @MaxLength(128)
  userId!: string;

  @IsObject()
  @IsDefined()
  envelope!: Record<string, unknown>;
}

export class CreateTeamSecretDto extends CreateSecretDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsDefined()
  @ValidateNested({ each: true })
  @Type(() => TeamSecretKeyEnvelopeDto)
  teamKeys!: TeamSecretKeyEnvelopeDto[];
}

export class ShareTeamSecretKeyDto {
  @IsObject()
  @IsDefined()
  envelope!: Record<string, unknown>;
}
