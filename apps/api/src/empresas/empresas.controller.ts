import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/auth';
import { EmpresasService } from './empresas.service';

@Controller('api/empresas')
export class EmpresasController {
  constructor(private readonly empresas: EmpresasService) {}

  @Get()
  @UseGuards(AdminGuard)
  listar() {
    return this.empresas.listar();
  }
}
