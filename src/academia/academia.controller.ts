import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AcademiaService } from './academia.service';
import type { PerfilAcademia, VideoAcademiaInput } from './academia.service';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { MotoboyGuard } from '../auth/motoboy.guard';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';

interface MarcarAssistidoBody {
  video_id: string;
}

@Controller('restaurante/academia/progresso')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteAcademiaController {
  constructor(private service: AcademiaService) {}

  @Get()
  obter(@Req() req: any) {
    return this.service.obter('estabelecimento', req.userId);
  }

  @Patch()
  marcar(@Req() req: any, @Body() body: MarcarAssistidoBody) {
    return this.service.marcarAssistido('estabelecimento', req.userId, body.video_id);
  }
}

@Controller('motoboy/academia/progresso')
@UseGuards(MotoboyGuard)
export class MotoboyAcademiaController {
  constructor(private service: AcademiaService) {}

  @Get()
  obter(@Req() req: any) {
    return this.service.obter('motoboy', req.userId);
  }

  @Patch()
  marcar(@Req() req: any, @Body() body: MarcarAssistidoBody) {
    return this.service.marcarAssistido('motoboy', req.userId, body.video_id);
  }
}

@Controller('perfil/academia/progresso')
@UseGuards(JwtGuard)
export class ClienteAcademiaController {
  constructor(private service: AcademiaService) {}

  @Get()
  obter(@Req() req: any) {
    return this.service.obter('cliente', req.userId);
  }

  @Patch()
  marcar(@Req() req: any, @Body() body: MarcarAssistidoBody) {
    return this.service.marcarAssistido('cliente', req.userId, body.video_id);
  }
}

// Catálogo público — usado pela página /academia. Sem guard: qualquer
// visitante (inclusive não logado) pode navegar os tutoriais.
@Controller('academia/catalogo')
export class AcademiaCatalogoController {
  constructor(private service: AcademiaService) {}

  @Get()
  listar(@Query('perfil') perfil?: PerfilAcademia) {
    return this.service.listarCatalogo(perfil);
  }
}

// Gestão dos vídeos (título, descrição, URL/upload, em quais painéis aparece)
@Controller('admin/academia')
@UseGuards(AdminGuard)
export class AdminAcademiaController {
  constructor(private service: AcademiaService) {}

  @Get('videos')
  listarTodos() {
    return this.service.listarTodosAdmin();
  }

  @Post('videos')
  criar(@Body() body: VideoAcademiaInput) {
    return this.service.criarVideo(body);
  }

  @Patch('videos/:id')
  atualizar(@Param('id') id: string, @Body() body: Partial<VideoAcademiaInput>) {
    return this.service.atualizarVideo(id, body);
  }

  @Delete('videos/:id')
  remover(@Param('id') id: string) {
    return this.service.removerVideo(id);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.service.uploadVideo(file);
  }
}
