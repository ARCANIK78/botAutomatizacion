import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { SessionStorageService } from './common/session-storage.service';
import { WhatsappService } from './whatsapp/whatsapp.service';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly sessionStorage: SessionStorageService,
  ) {}

  /** Deja visible en los logs si la sesión sobrevivirá a un redeploy. */
  async onApplicationBootstrap(): Promise<void> {
    await this.sessionStorage.logAlArrancar();
  }

  async health() {
    const status = this.whatsapp.getStatus(false);
    return {
      status: 'ok' as const,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
      whatsapp: { state: status.state, user: status.user },
      sesion: await this.sessionStorage.check(),
    };
  }
}
