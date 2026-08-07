import { IsInt } from 'class-validator';

export class AtribuirAssinaturaDto {
  @IsInt()
  plano_id: number;
}
