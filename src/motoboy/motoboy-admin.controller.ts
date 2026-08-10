import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { MotoboyService } from './motoboy.service';

@Controller('admin/motoboys')
@UseGuards(AdminGuard)
export class MotoboyAdminController {
  constructor(private service: MotoboyService) {}

  @Get()
  listar(@Query('status') status?: string) {
    return this.service.listarMotoboysAdmin(status);
  }

  @Get(':id')
  detalhe(@Param('id', ParseIntPipe) id: number) {
    return this.service.detalheMotoboyAdmin(id);
  }

  @Patch(':id/aprovar')
  aprovar(@Param('id', ParseIntPipe) id: number) {
    return this.service.aprovarMotoboyAdmin(id);
  }

  @Patch(':id/recusar')
  recusar(@Param('id', ParseIntPipe) id: number, @Body() body: { motivo?: string }) {
    return this.service.recusarMotoboyAdmin(id, body.motivo);
  }
}
