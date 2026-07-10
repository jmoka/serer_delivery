import {
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { AdminGuard } from '../auth/admin.guard';

// Público: GET /api/tags (restaurante usa pra montar form de produto)
@Controller('tags')
export class TagsPublicoController {
  constructor(private service: TagsService) {}

  @Get()
  listar() {
    return this.service.listar(true);
  }

  // Carrosseis do catálogo público de um restaurante
  @Get('carrosseis/:restaurantId')
  carrosseis(@Param('restaurantId', ParseIntPipe) restaurantId: number) {
    return this.service.getCarrosseis(restaurantId);
  }
}

// Admin: /api/admin/tags
@Controller('admin/tags')
@UseGuards(AdminGuard)
export class TagsAdminController {
  constructor(private service: TagsService) {}

  @Get()
  listarTodas() {
    return this.service.listar(false);
  }

  @Post()
  criar(@Body() body: { name: string; slug: string; descricao?: string; is_auto?: boolean; ordem?: number }) {
    return this.service.criar(body);
  }

  @Patch(':id')
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<{ name: string; descricao: string; ordem: number; ativo: boolean }>,
  ) {
    return this.service.atualizar(id, body);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }
}
