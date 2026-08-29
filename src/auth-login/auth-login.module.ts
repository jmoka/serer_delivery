import { Module } from '@nestjs/common';
import { AuthLoginController } from './auth-login.controller';
import { AuthLoginService } from './auth-login.service';

@Module({
  controllers: [AuthLoginController],
  providers: [AuthLoginService],
})
export class AuthLoginModule {}
