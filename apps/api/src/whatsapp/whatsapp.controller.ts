import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { isAdminRequest, AdminGuard } from '../common/auth';
import { AssistantService } from '../assistant/assistant.service';
import { AllowlistService } from './allowlist.service';
import { WhatsappService } from './whatsapp.service';

@Controller('api/whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly allowlist: AllowlistService,
    private readonly assistant: AssistantService,
  ) {}

  @Get('status')
  status(
    @Headers('x-admin-token') xAdminToken?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const authorized = isAdminRequest(xAdminToken, authorization);
    return this.whatsapp.getStatus(authorized);
  }

  @Get('qr')
  @UseGuards(AdminGuard)
  qr() {
    const status = this.whatsapp.getStatus(true);
    if (!status.qr) throw new NotFoundException('No hay un QR disponible');
    return { qr: status.qr, state: status.state };
  }

  @Post('connect')
  @UseGuards(AdminGuard)
  connect() {
    return this.whatsapp.start();
  }

  @Post('send')
  @UseGuards(AdminGuard)
  send(@Body() body: { to?: string; message?: string }) {
    return this.whatsapp.send(
      String(body?.to ?? ''),
      String(body?.message ?? ''),
    );
  }

  @Get('allowed')
  @UseGuards(AdminGuard)
  listAllowed() {
    return { numbers: this.allowlist.list() };
  }

  @Post('allowed')
  @UseGuards(AdminGuard)
  addAllowed(@Body() body: { number?: string }) {
    return { numbers: this.allowlist.add(String(body?.number ?? '')) };
  }

  @Delete('allowed/:number')
  @UseGuards(AdminGuard)
  removeAllowed(@Param('number') number: string) {
    return { numbers: this.allowlist.remove(number) };
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
