import { Module } from '@nestjs/common';
import { PlataformaController } from './plataforma.controller';
import { PlataformaService } from './plataforma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PlataformaController],
  providers: [PlataformaService],
})
export class PlataformaModule {}
