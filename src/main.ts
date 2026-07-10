import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { McpService } from './mcp/mcp.service';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const isMcpMode = process.env.MCP_MODE === 'stdio';

  if (isMcpMode) {
    const app = await NestFactory.createApplicationContext(AppModule);
    const mcp = app.get(McpService);
    await mcp.conectarStdio();
    return;
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Valida e sanitiza todos os DTOs globalmente — nunca confiar só no frontend
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(process.env.PORT ?? 3002);
  console.log(`Delivery Backend rodando na porta ${process.env.PORT ?? 3002}`);
}

bootstrap();
