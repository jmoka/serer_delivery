import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { join } from 'path';
import { SupabaseModule } from './supabase/supabase.module';
import { CommonModule } from './common/common.module';
import { RedisModule } from './redis/redis.module';
import { EstoqueModule } from './estoque/estoque.module';
import { CombosModule } from './combos/combos.module';
import { AuthModule } from './auth/auth.module';
import { McpModule } from './mcp/mcp.module';
import { EmpresasModule } from './empresas/empresas.module';
import { CategoriasModule } from './categorias/categorias.module';
import { ProdutosModule } from './produtos/produtos.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { PlataformaModule } from './plataforma/plataforma.module';
import { PagamentosModule } from './pagamentos/pagamentos.module';
import { RestauranteModule } from './restaurante/restaurante.module';
import { MotoboyModule } from './motoboy/motoboy.module';
import { PerfilModule } from './perfil/perfil.module';
import { TagsModule } from './tags/tags.module';
import { SalaoModule } from './salao/salao.module';
import { AgenteImpressaoModule } from './agente-impressao/agente-impressao.module';
import { PlanosModule } from './planos/planos.module';
import { InstalacoesModule } from './instalacoes/instalacoes.module';
import { LicencaModule } from './licenca/licenca.module';
import { UsuariosModule } from './usuarios/usuarios.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(__dirname, '..', '.env'),
        join(__dirname, '..', '..', '.env'),
        '.env',
      ],
    }),
    // Limite padrão de toda a API (ver POLITICAS.md do vault de segurança:
    // "API: 100 requisições por minuto"). Endpoints de login/cadastro usam
    // @Throttle com limite mais apertado (ver motoboy-auth/garcom-auth).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    SupabaseModule,
    CommonModule,
    RedisModule,
    EstoqueModule,
    CombosModule,
    AuthModule,
    McpModule,
    EmpresasModule,
    CategoriasModule,
    ProdutosModule,
    PedidosModule,
    PlataformaModule,
    PagamentosModule,
    RestauranteModule,
    MotoboyModule,
    PerfilModule,
    TagsModule,
    SalaoModule,
    AgenteImpressaoModule,
    PlanosModule,
    InstalacoesModule,
    LicencaModule,
    UsuariosModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
