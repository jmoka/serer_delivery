import { Global, Module } from '@nestjs/common';
import { CombosService } from './combos.service';

@Global()
@Module({
  providers: [CombosService],
  exports: [CombosService],
})
export class CombosModule {}
