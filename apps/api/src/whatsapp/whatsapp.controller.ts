import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isAdminRequest, AdminGuard } from '../common/auth';
import { AssistantService } from '../assistant/assistant.service';
import { AllowlistService } from './allowlist.service';
import { SessionManagerService } from './session-manager.service';

@Controller('api/whatsapp')
export class WhatsappController {
  constructor(
    private readonly sessionManager: SessionManagerService,
    private readonly allowlist: AllowlistService,
    private readonly assistant: AssistantService,
  ) {}

  @Get('empresas')
  @UseGuards(AdminGuard)
  listSessions() {
    return { sessions: this.sessionManager.list() };
  }

  @Get('status')
  status(
    @Headers('x-admin-token') xAdminToken?: string,
    @Headers('authorization') authorization?: string,
    @Query('empresaId') empresaId?: string,
  ) {
    const authorized = isAdminRequest(xAdminToken, authorization);
    const id = empresaId ?? 'default';
    const session = this.sessionManager.get(id);
    if (!session) {
      return { state: 'disconnected', qr: null, user: null, at: Date.now() };
    }
    return session.getStatus(authorized);
  }

  @Get('qr')
  @UseGuards(AdminGuard)
  qr(@Query('empresaId') empresaId?: string) {
    const id = empresaId ?? 'default';
    const session = this.sessionManager.get(id);
    if (!session) throw new NotFoundException(`Empresa ${id} no encontrada`);
    const status = session.getStatus(true);
    if (!status.qr) throw new NotFoundException('No hay un QR disponible');
    return { qr: status.qr, state: status.state, empresaId: id };
  }

  @Post('connect')
  @UseGuards(AdminGuard)
  async connect(@Body() body: { empresaId?: string; empresaNombre?: string }) {
    const id = body.empresaId ?? 'default';
    const nombre = body.empresaNombre ?? id;
    await this.sessionManager.startSession(id, nombre);
    const session = this.sessionManager.get(id);
    return session!.getStatus(true);
  }

  @Post('send')
  @UseGuards(AdminGuard)
  async send(
    @Body() body: { empresaId?: string; to?: string; message?: string },
  ) {
    const id = body.empresaId ?? 'default';
    const session = this.sessionManager.get(id);
    if (!session) throw new NotFoundException(`Empresa ${id} no encontrada`);
    return session.send(String(body?.to ?? ''), String(body?.message ?? ''));
  }

  @Get('allowed')
  @UseGuards(AdminGuard)
  listAllowed(@Query('empresaId') empresaId?: string) {
    return { numbers: this.allowlist.list(empresaId) };
  }

  @Post('allowed')
  @UseGuards(AdminGuard)
  addAllowed(@Body() body: { number?: string; empresaId?: string }) {
    return {
      numbers: this.allowlist.add(
        String(body?.number ?? ''),
        body.empresaId,
      ),
    };
  }

  @Delete('allowed/:number')
  @UseGuards(AdminGuard)
  removeAllowed(
    @Param('number') number: string,
    @Query('empresaId') empresaId?: string,
  ) {
    return { numbers: this.allowlist.remove(number, empresaId) };
  }

  @Delete('session/:empresaId')
  @UseGuards(AdminGuard)
  removeSession(@Param('empresaId') empresaId: string) {
    const removed = this.sessionManager.remove(empresaId);
    if (!removed) throw new NotFoundException(`Empresa ${empresaId} no encontrada`);
    return { ok: true };
  }

  @Post('test-llm')
  @UseGuards(AdminGuard)
  async testLlm(@Body() body: { text?: string; from?: string }) {
    const text = String(body?.text ?? '').trim();
    if (!text) return { ok: false, error: 'Falta el campo "text"' };
    const fromNumber = String(body?.from ?? '59170000000').replace(/\D/g, '');
    const reply = await this.assistant.reply({
      id: null,
      from: `${fromNumber}@s.whatsapp.net`,
      fromNumber,
      body: text,
      timestamp: Date.now(),
      chatType: 'direct',
    });
    return { ok: true, enabled: this.assistant.enabled, reply };
  }
}
