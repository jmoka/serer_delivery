import { Module } from '@nestjs/common';
import { RestauranteController } from './restaurante.controller';
import { OnboardingController } from './onboarding.controller';
import { CatalogoController } from './catalogo.controller';
import { CozinhaPortalController } from './cozinha-portal.controller';
import { KdsPortalController } from './kds-portal.controller';
import { RestauranteService } from './restaurante.service';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { CategoriasModule } from '../categorias/categorias.module';
import { ProdutosModule } from '../produtos/produtos.module';
import { PedidosModule } from '../pedidos/pedidos.module';
import { MotoboyModule } from '../motoboy/motoboy.module';
import { SalaoModule } from '../salao/salao.module';

@Module({
  imports: [AuthModule, SupabaseModule, CategoriasModule, ProdutosModule, PedidosModule, MotoboyModule, SalaoModule],
  controllers: [RestauranteController, OnboardingController, CatalogoController, CozinhaPortalController, KdsPortalController],
  providers: [RestauranteService, CozinhaGuard],
})
export class RestauranteModule {}
