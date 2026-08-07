import { IsInt } from 'class-validator';

export class AtribuirPlanoInstalacaoDto {
  @IsInt()
  plano_id: number;
}
