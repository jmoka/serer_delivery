import { Global, Module } from '@nestjs/common';
import { EstoqueService } from './estoque.service';

@Global()
@Module({
  providers: [EstoqueService],
  exports: [EstoqueService],
})
export class EstoqueModule {}
