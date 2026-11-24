import { Controller, Get, Header, Param } from '@nestjs/common';
import { MotoboyAcaoLinkService } from './motoboy-acao-link.service';
import { MotoboyService } from './motoboy.service';

// Público (sem guard) — o token já é a prova de identidade (uso único, 6h, vinculado a
// motoboy_id+order_id). Clique vindo da mensagem Telegram/WhatsApp executa a ação direto,
// sem precisar logar no app. Ver MotoboyAcaoLinkService pra geração/resgate do token.
@Controller('motoboy/acao')
export class MotoboyAcaoLinkController {
  constructor(
    private acaoLink: MotoboyAcaoLinkService,
    private motoboyService: MotoboyService,
  ) {}

  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async executar(@Param('token') token: string): Promise<string> {
    const resgate = await this.acaoLink.resgatar(token);
    if (!resgate) return pagina('Link inválido', 'Esse link já foi usado ou não existe.');
    if (resgate.expirado) return pagina('Link expirado', 'Esse link expirou. Abra o app pra ver os pedidos disponíveis.');

    try {
      if (resgate.acao === 'concorrer') {
        await this.motoboyService.registrarInteresse(resgate.motoboyId, resgate.orderId);
        return pagina('Você está concorrendo! ✅', `Pedido #${resgate.orderId} — avisamos por aqui quando ele ficar pronto pra retirada.`);
      }
      await this.motoboyService.pegarPedido(resgate.orderId, resgate.motoboyId);
      return pagina('Pedido seu! 🛵', `Pedido #${resgate.orderId} é seu — pode ir buscar.`);
    } catch (e: any) {
      return pagina('Não foi possível', e?.message ?? 'Abra o app pra ver o status desse pedido.');
    }
  }
}

function pagina(titulo: string, mensagem: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${titulo}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #1e293b; border-radius: 16px; padding: 32px 24px; max-width: 360px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; color: #cbd5e1; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>${titulo}</h1>
    <p>${mensagem}</p>
  </div>
</body>
</html>`;
}
