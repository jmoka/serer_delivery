import { Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SupabaseService } from '../supabase/supabase.service';
import { empresasToolDefinitions, executarEmpresasTool } from './tools/empresas.tools';
import { pedidosToolDefinitions, executarPedidosTool } from './tools/pedidos.tools';
import { produtosToolDefinitions, executarProdutosTool } from './tools/produtos.tools';

const ALL_TOOLS = [
  ...empresasToolDefinitions,
  ...pedidosToolDefinitions,
  ...produtosToolDefinitions,
];

@Injectable()
export class McpService {
  private server: Server;

  constructor(private supabase: SupabaseService) {
    this.server = new Server(
      { name: 'delivery-base-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.registrarHandlers();
  }

  private registrarHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ALL_TOOLS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, any>;
      const db = this.supabase.client;

      try {
        const resultado =
          (await executarEmpresasTool(name, toolArgs, db)) ??
          (await executarPedidosTool(name, toolArgs, db)) ??
          (await executarProdutosTool(name, toolArgs, db));

        if (resultado === null) {
          return {
            content: [{ type: 'text', text: `Tool desconhecida: ${name}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Erro: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    });
  }

  async conectarStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
