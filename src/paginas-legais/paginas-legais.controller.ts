import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { PaginasLegaisService } from './paginas-legais.service';
import { AdminGuard } from '../auth/admin.guard';

interface AtualizarPaginaLegalBody {
  titulo?: string;
  conteudo?: string;
}

// Público, sem guard — Termos de Uso e Política de Privacidade precisam ser
// lidos por qualquer visitante, inclusive antes de criar conta.
@Controller('paginas-legais')
export class PaginasLegaisController {
  constructor(private service: PaginasLegaisService) {}

  @Get(':slug')
  obterPorSlug(@Param('slug') slug: string) {
    return this.service.obterPorSlug(slug);
  }
}

@Controller('admin/paginas-legais')
@UseGuards(AdminGuard)
export class AdminPaginasLegaisController {
  constructor(private service: PaginasLegaisService) {}

  @Get()
  listarTodas() {
    return this.service.listarTodas();
  }

  @Patch(':slug')
  atualizar(@Param('slug') slug: string, @Req() req: any, @Body() body: AtualizarPaginaLegalBody) {
    return this.service.atualizar(slug, req.userId, body);
  }
}
