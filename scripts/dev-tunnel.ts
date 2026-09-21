// Sobe um túnel Cloudflare temporário (quick tunnel, sem conta/token) apontando
// pro backend local e já inicia o `nest start --watch` com TELEGRAM_WEBHOOK_URL
// configurado pra essa URL — pra testar qualquer fluxo que dependa de webhook
// (hoje: vínculo Telegram) sem precisar de intervenção manual a cada sessão.
//
// NÃO usa o túnel nomeado de produção (docker-compose.yml + CLOUDFLARE_TUNNEL_TOKEN,
// atrelado ao domínio real) — é um túnel efêmero e completamente separado,
// zero risco de misturar tráfego com produção.
//
// Uso: npm run dev:tunnel   (dentro de server_delivery, com .env configurado)
import 'dotenv/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PORT = process.env.PORT ?? '3002';
const ENV_PATH = path.resolve(__dirname, '..', '.env');
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function atualizarWebhookUrlNoEnv(webhookUrl: string) {
  if (!fs.existsSync(ENV_PATH)) return;
  const conteudo = fs.readFileSync(ENV_PATH, 'utf8');
  const linha = `TELEGRAM_WEBHOOK_URL=${webhookUrl}`;
  const novoConteudo = /^TELEGRAM_WEBHOOK_URL=.*$/m.test(conteudo)
    ? conteudo.replace(/^TELEGRAM_WEBHOOK_URL=.*$/m, linha)
    : `${conteudo.trimEnd()}\n${linha}\n`;
  fs.writeFileSync(ENV_PATH, novoConteudo);
  console.log(`[dev-tunnel] .env atualizado: ${linha}`);
}

console.log(`[dev-tunnel] Subindo túnel Cloudflare (quick tunnel) para http://localhost:${PORT}...`);

const tunnel = spawn(`npx --yes cloudflared tunnel --url http://localhost:${PORT}`, {
  shell: true,
});

let backend: ReturnType<typeof spawn> | null = null;
let urlCapturada = false;

const tratarSaidaTunnel = (chunk: Buffer) => {
  const texto = chunk.toString();
  process.stderr.write(`[cloudflared] ${texto}`);

  if (urlCapturada) return;
  const match = texto.match(TUNNEL_URL_RE);
  if (!match) return;

  urlCapturada = true;
  const webhookUrl = `${match[0]}/telegram/webhook`;
  atualizarWebhookUrlNoEnv(webhookUrl);

  console.log(`[dev-tunnel] Túnel pronto: ${match[0]}`);
  console.log('[dev-tunnel] Iniciando backend (nest start --watch)...');

  backend = spawn('npx nest start --watch', {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, TELEGRAM_WEBHOOK_URL: webhookUrl },
  });

  backend.on('exit', (code) => {
    tunnel.kill();
    process.exit(code ?? 0);
  });
};

tunnel.stdout?.on('data', tratarSaidaTunnel);
tunnel.stderr?.on('data', tratarSaidaTunnel);

tunnel.on('exit', (code) => {
  if (!urlCapturada) {
    console.error('[dev-tunnel] Túnel encerrou antes de gerar uma URL.');
    process.exit(code ?? 1);
  }
});

process.on('SIGINT', () => {
  backend?.kill();
  tunnel.kill();
  process.exit(0);
});
