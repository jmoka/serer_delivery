import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckinDto {
  @IsString()
  @MaxLength(80)
  serial: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  versao?: string;
}
