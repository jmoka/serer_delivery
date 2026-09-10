import { IsInt, IsNotEmptyObject, IsObject } from 'class-validator';

export class CriarBoostDto {
  @IsInt()
  pacote_id: number;

  // Mapa carrossel -> item_ids selecionados nesse carrossel. Precisa cobrir
  // exatamente os carrosséis (e as quantidades) da composição do pacote —
  // validado no service, não dá pra expressar isso em decorators simples.
  @IsObject()
  @IsNotEmptyObject()
  itens: Record<string, number[]>;
}
