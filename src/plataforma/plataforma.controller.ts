import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import * as os from 'os';
import { PlataformaService } from './plataforma.service';
import { AdminGuard } from '../auth/admin.guard';
import { UpdateConfigDto } from './update-config.dto';

@Controller('plataforma')
@UseGuards(AdminGuard)
export class PlataformaController {
  constructor(private service: PlataformaService) {}

  @Get('config')
  getConfig() {
    return this.service.getConfig();
  }

  @Patch('config')
  updateConfig(@Body() body: UpdateConfigDto) {
    return this.service.updateConfig(body);
  }

  @Get('rede')
  getRede() {
    const nets = os.networkInterfaces();
    const todos: string[] = [];
    for (const iface of Object.values(nets)) {
      for (const net of iface ?? []) {
        if (net.family === 'IPv4' && !net.internal) todos.push(net.address);
      }
    }
    const score = (ip: string) => {
      if (/^192\.168\./.test(ip)) return 0;
      if (/^10\./.test(ip)) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 99;
      return 2;
    };
    const ips = todos.sort((a, b) => score(a) - score(b));
    return { ips, porta: 4028 };
  }

  @Get('metricas')
  metricas() {
    return this.service.metricas();
  }

  @Get('comissoes')
  comissoes(
    @Query('empresa_id') empresaId?: string,
    @Query('data_inicio') dataInicio?: string,
    @Query('data_fim') dataFim?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.comissoes({
      empresa_id: empresaId ? parseInt(empresaId) : undefined,
      data_inicio: dataInicio,
      data_fim: dataFim,
      limite: limite ? parseInt(limite) : undefined,
    });
  }

  @Get('comissoes/empresa/:id')
  comissoesPorEmpresa(@Param('id', ParseIntPipe) id: number) {
    return this.service.comissoesPorEmpresa(id);
  }
}
