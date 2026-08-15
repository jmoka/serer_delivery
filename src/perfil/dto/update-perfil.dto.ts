import { IsOptional, IsString, IsObject, MaxLength } from 'class-validator';

export class UpdatePerfilDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone_e164?: string;

  @IsOptional()
  @IsObject()
  address_json?: Record<string, any>;
}
