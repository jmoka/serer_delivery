import { Module } from '@nestjs/common';
import { PaginasLegaisController, AdminPaginasLegaisController } from './paginas-legais.controller';
import { PaginasLegaisService } from './paginas-legais.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PaginasLegaisController, AdminPaginasLegaisController],
  providers: [PaginasLegaisService],
})
export class PaginasLegaisModule {}
