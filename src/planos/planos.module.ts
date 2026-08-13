import { Module } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { PlanosAdminController } from './planos-admin.controller';
import { PlanosRestauranteController } from './planos-restaurante.controller';
import { PlanosWebhookController } from './planos-webhook.controller';
import { AuthModule } from '../auth/auth.module';
import { UsuariosModule } from '../usuarios/usuarios.module';

@Module({
  imports: [AuthModule, UsuariosModule],
  controllers: [PlanosAdminController, PlanosRestauranteController, PlanosWebhookController],
  providers: [PlanosService],
  exports: [PlanosService],
})
export class PlanosModule {}
