import { Module } from '@nestjs/common';
import { PagamentosController } from './pagamentos.controller';
import { PagamentosService } from './pagamentos.service';
import { AuthModule } from '../auth/auth.module';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [AuthModule, StripeModule],
  controllers: [PagamentosController],
  providers: [PagamentosService],
})
export class PagamentosModule {}
