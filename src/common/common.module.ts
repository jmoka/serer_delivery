import { Global, Module } from '@nestjs/common';
import { CorsOriginsService } from './cors-origins.service';

// Global (mesmo padrão do SupabaseModule): CorsOriginsService agora é dependência de
// RestaurantOwnerGuard, usado via @UseGuards() em módulos espalhados pelo app (não só
// AuthModule) — sem @Global(), cada um deles precisaria importar CommonModule também.
@Global()
@Module({
  providers: [CorsOriginsService],
  exports: [CorsOriginsService],
})
export class CommonModule {}
