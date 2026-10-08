import { Injectable } from '@nestjs/common';
import { WhatsappService } from './whatsapp/whatsapp.service';

@Injectable()
export class AppService {
  constructor(private readonly whatsapp: WhatsappService) {}

  health() {
    const status = this.whatsapp.getStatus(false);
    return {
      status: 'ok' as const,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
      whatsapp: { state: status.state, user: status.user },
    };
  }
}
