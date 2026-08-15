import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { McpService } from './mcp/mcp.service';
import { ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';
import { CorsOriginsService } from './common/cors-origins.service';

async function bootstrap() {
  const isMcpMode = process.env.MCP_MODE === 'stdio';

  if (isMcpMode) {
    const app = await NestFactory.createApplicationContext(AppModule);
    const mcp = app.get(McpService);
    await mcp.conectarStdio();
    return;
  }

  const app = await NestFactory.create(AppModule);
  app.use(helmet());

  const corsOrigins = app.get(CorsOriginsService);
  app.enableCors({
    origin: async (origin, callback) => {
      if (!origin) return callback(null, true); // server-to-server, sem browser
      const ok = await corsOrigins.estaPermitida(origin);
      // callback(null, false) nega sem levantar erro — resposta segue normal,
      // só sem os headers Access-Control-*, e o browser bloqueia no cliente.
      callback(null, ok);
    },
    credentials: true,
  });
  // Uploads de foto/documento do motoboy vêm em base64 no corpo JSON — acima do default (~100kb)
  app.use(json({ limit: '12mb' }));
  // Valida e sanitiza todos os DTOs globalmente — nunca confiar só no frontend
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(process.env.PORT ?? 3002);
  console.log(`Delivery Backend rodando na porta ${process.env.PORT ?? 3002}`);
}

bootstrap();
