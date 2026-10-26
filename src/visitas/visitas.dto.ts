import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RegistrarVisitaDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  empresa_id?: string;

  @IsString()
  @MaxLength(500)
  path_inicial: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;
}
