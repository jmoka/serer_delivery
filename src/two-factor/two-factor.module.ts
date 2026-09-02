import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';
import { TwoFactorEmailService } from './two-factor-email.service';

@Module({
  imports: [AuthModule],
  controllers: [TwoFactorController],
  providers: [TwoFactorService, TwoFactorEmailService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
