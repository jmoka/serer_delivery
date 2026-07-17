import { Body, Controller, Get, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtGuard } from '../auth/jwt.guard';
import { PerfilService } from './perfil.service';

@Controller('perfil')
@UseGuards(JwtGuard)
export class PerfilController {
  constructor(private service: PerfilService) {}

  @Get()
  get(@Req() req: any) {
    return this.service.getMeuPerfil(req.userId);
  }

  @Patch()
  update(
    @Req() req: any,
    @Body() body: { name?: string; phone_e164?: string; address_json?: Record<string, any> },
  ) {
    return this.service.updateMeuPerfil(req.userId, body);
  }

  @Post('foto')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadFoto(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    return this.service.uploadFoto(req.userId, file);
  }
}
