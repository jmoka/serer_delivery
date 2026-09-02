import { Module } from '@nestjs/common';
import { AuthLoginController } from './auth-login.controller';
import { AuthLoginService } from './auth-login.service';
import { TwoFactorModule } from '../two-factor/two-factor.module';

@Module({
  imports: [TwoFactorModule],
  controllers: [AuthLoginController],
  providers: [AuthLoginService],
})
export class AuthLoginModule {}
