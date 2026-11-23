import { Body, Controller, Delete, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { ModuloAssistenteIaGuard } from '../auth/modulo-assistente-ia.guard';
import { AssistenteService } from './assistente.service';

// Dono conectando/configurando o PRÓPRIO assistente — nada aqui tem a ver com
// TelegramService/WhatsappService (notificações transacionais do Pediuvai).
@Controller('restaurante/assistente')
@UseGuards(RestaurantOwnerGuard, ModuloAssistenteIaGuard)
export class AssistenteController {
  constructor(private service: AssistenteService) {}

  @Get()
  config(@Req() req: any) {
    return this.service.obterConfig(req.restaurantId);
  }

  @Patch('prompt')
  salvarPrompt(@Body() body: { prompt: string }, @Req() req: any) {
    return this.service.salvarPrompt(req.restaurantId, body.prompt);
  }

  @Post('telegram/conectar')
  conectarTelegram(@Body() body: { token: string }, @Req() req: any) {
    return this.service.conectarTelegram(req.restaurantId, body.token);
  }

  @Delete('telegram')
  desconectarTelegram(@Req() req: any) {
    return this.service.desconectarTelegram(req.restaurantId);
  }

  @Post('whatsapp/conectar')
  conectarWhatsapp(@Req() req: any) {
    return this.service.conectarWhatsapp(req.restaurantId);
  }

  @Get('whatsapp/status')
  statusWhatsapp(@Req() req: any) {
    return this.service.statusWhatsapp(req.restaurantId);
  }

  @Delete('whatsapp')
  desconectarWhatsapp(@Req() req: any) {
    return this.service.desconectarWhatsapp(req.restaurantId);
  }
}
