import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from './common/auth';
import { Backend1AuthService } from './common/backend1-auth.service';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly backend1: Backend1AuthService,
  ) {}

  @Get('health')
  health() {
    return this.appService.health();
  }

  @Get('api/health')
  healthApi() {
    return this.appService.health();
  }

  /**
   * Diagnóstico de conectividad con Backend 1 (Contabily).
   * Útil desde el Shell de Render:
   *   curl http://localhost:$PORT/api/health/backend1
   * Distingue "problema de red" de "token inválido/expirado".
   */
  @Get('api/health/backend1')
  @UseGuards(AdminGuard)
  async backend1Health() {
    return this.backend1.diagnose();
  }
}
