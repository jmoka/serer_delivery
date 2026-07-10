import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { SupabaseModule } from './supabase/supabase.module';
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
    SupabaseModule,
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
  ],
})
export class AppModule {}
