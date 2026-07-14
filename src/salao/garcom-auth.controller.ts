import { Body, Controller, Post } from '@nestjs/common';
import { GarcomAuthService } from './garcom-auth.service';

@Controller('garcom/auth')
export class GarcomAuthController {
  constructor(private service: GarcomAuthService) {}

  @Post('login')
  login(@Body() body: { login_key: string; password: string }) {
    return this.service.login(body.login_key, body.password);
  }
}
