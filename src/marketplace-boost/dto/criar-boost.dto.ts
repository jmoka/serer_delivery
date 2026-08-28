import { ArrayMinSize, IsInt, IsArray } from 'class-validator';

export class CriarBoostDto {
  @IsInt()
  pacote_id: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  item_ids: number[];
}
