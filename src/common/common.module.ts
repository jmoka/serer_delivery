import { Global, Module } from '@nestjs/common';
import { CorsOriginsService } from './cors-origins.service';
import { EncryptionService } from './encryption.service';

// Global (mesmo padrão do SupabaseModule): CorsOriginsService agora é dependência de
// RestaurantOwnerGuard, usado via @UseGuards() em módulos espalhados pelo app (não só
// AuthModule) — sem @Global(), cada um deles precisaria importar CommonModule também.
// EncryptionService segue o mesmo padrão — usado por services de vários módulos
// (perfil, restaurante, motoboy, gdoor) pra criptografar/descriptografar PII.
@Global()
@Module({
  providers: [CorsOriginsService, EncryptionService],
  exports: [CorsOriginsService, EncryptionService],
})
export class CommonModule {}
