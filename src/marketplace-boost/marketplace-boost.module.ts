import { Module } from '@nestjs/common';
import { MarketplaceBoostService } from './marketplace-boost.service';
import { MarketplaceBoostRestauranteController } from './marketplace-boost-restaurante.controller';
import { MarketplaceBoostAdminController } from './marketplace-boost-admin.controller';
import { MarketplaceBoostWebhookController } from './marketplace-boost-webhook.controller';
import { AuthModule } from '../auth/auth.module';
import { TagsModule } from '../tags/tags.module';

@Module({
  imports: [AuthModule, TagsModule],
  controllers: [MarketplaceBoostRestauranteController, MarketplaceBoostAdminController, MarketplaceBoostWebhookController],
  providers: [MarketplaceBoostService],
  exports: [MarketplaceBoostService],
})
export class MarketplaceBoostModule {}
