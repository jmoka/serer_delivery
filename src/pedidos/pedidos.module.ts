import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { AuthModule } from '../auth/auth.module';
import { MotoboyModule } from '../motoboy/motoboy.module';
import { SalaoModule } from '../salao/salao.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [AuthModule, MotoboyModule, SalaoModule, TelegramModule],
  controllers: [PedidosController],
  providers: [PedidosService],
  exports: [PedidosService],
})
export class PedidosModule {}
