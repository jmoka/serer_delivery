import { Module } from '@nestjs/common';
import { TagsService } from './tags.service';
import { TagsPublicoController, TagsAdminController } from './tags.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [TagsPublicoController, TagsAdminController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
