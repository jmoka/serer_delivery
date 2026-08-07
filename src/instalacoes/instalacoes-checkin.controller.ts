import { Body, Controller, Post } from '@nestjs/common';
import { InstalacoesService } from './instalacoes.service';
import { CheckinDto } from './dto/checkin.dto';

// Sem guard — instalação local não tem sessão/JWT contra a central,
// o serial em si é a credencial (mesmo padrão do webhook do PagBank).
@Controller('instalacoes')
export class InstalacoesCheckinController {
  constructor(private service: InstalacoesService) {}

  @Post('checkin')
  checkin(@Body() body: CheckinDto) {
    return this.service.checkin(body.serial);
  }
}
