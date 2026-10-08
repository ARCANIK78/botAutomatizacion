import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../config';
import { safeEqual } from '../common/auth';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { IdempotencyCache } from './idempotency.cache';

interface NotifyPayload {
  to?: unknown;
  message?: unknown;
  idempotencyKey?: unknown;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly idempotency = new IdempotencyCache();

  constructor(private readonly whatsapp: WhatsappService) {}

  async notify(
    payload: NotifyPayload,
    authorization?: string,
  ): Promise<{ ok: boolean; to: string; duplicate: boolean }> {
    const sharedToken = env.sharedToken();
    if (!sharedToken) {
      throw new ServiceUnavailableException(
        'BACKEND1_SHARED_TOKEN no está configurado en el servidor',
      );
    }

    const given = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!given || !safeEqual(given, sharedToken)) {
      throw new UnauthorizedException('Token de backend 1 inválido');
    }

    const to = typeof payload?.to === 'string' ? payload.to.trim() : '';
    const message =
      typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!to || !message) {
      throw new BadRequestException(
        'Los campos "to" y "message" son obligatorios',
      );
    }

    const key =
      typeof payload.idempotencyKey === 'string' &&
      payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : null;

    if (key && this.idempotency.has(key)) {
      this.logger.log(`Notificación duplicada ignorada (${key})`);
      return { ok: true, to, duplicate: true };
    }

    const result = await this.whatsapp.send(to, message);
    if (key) this.idempotency.set(key);

    return { ok: result.ok, to: result.to, duplicate: false };
  }
}
