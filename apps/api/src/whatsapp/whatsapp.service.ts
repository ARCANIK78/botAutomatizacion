import { mkdir } from 'node:fs/promises';
import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import QRCode from 'qrcode';
import pino from 'pino';
import { AssistantService } from '../assistant/assistant.service';
import { decideAccess } from '../common/access';
import { normalizePhone } from '../common/phone';
import { env } from '../config';
import { AllowlistService } from './allowlist.service';

type BaileysModule = typeof import('@whiskeysockets/baileys');
type WASocket = import('@whiskeysockets/baileys').WASocket;
type ConnectionState = import('@whiskeysockets/baileys').ConnectionState;
type WAMessage = import('@whiskeysockets/baileys').WAMessage;

const SOCKET_SETTLE_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type WaState =
  'disconnected' | 'connecting' | 'waiting_for_qr' | 'connected';

export interface WaStatus {
  state: WaState;
  qr: string | null;
  user: string | null;
  at: number;
}

export interface InboundMessage {
  id: string | null;
  from: string;
  fromNumber: string;
  body: string;
  timestamp: number;
  chatType: 'direct' | 'group';
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;
  private baileys: BaileysModule | null = null;
  private state: WaState = 'disconnected';
  private qrDataUrl: string | null = null;
  private user: string | null = null;
  private attempts = 0;
  private generation = 0;
  private starting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly assistant: AssistantService,
    private readonly allowlist: AllowlistService,
  ) {}

  onModuleInit(): void {
    if (!env.autoStart()) return;
    void this.start().catch((err: Error) =>
      this.logger.error(`No se pudo iniciar Baileys: ${err.message}`),
    );
  }

  onModuleDestroy(): void {
    this.clearReconnectTimer();
    this.generation += 1;
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        void sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
  }

  getStatus(includeQr = true): WaStatus {
    return {
      state: this.state,
      qr: includeQr ? this.qrDataUrl : null,
      user: this.user,
      at: Date.now(),
    };
  }

  async start(): Promise<WaStatus> {
    if (this.starting) return this.getStatus(true);
    this.starting = true;
    const generation = ++this.generation;

    try {
      this.clearReconnectTimer();
      const previous = this.sock;
      this.sock = null;
      if (previous) {
        try {
          await Promise.resolve(previous.end(undefined));
        } catch {
          /* ignore */
        }
        await delay(SOCKET_SETTLE_MS);
      }

      this.state = 'connecting';
      this.qrDataUrl = null;
      this.user = null;

      const mod = await import('@whiskeysockets/baileys');
      if (generation !== this.generation) return this.getStatus(true);
      this.baileys = mod;

      await mkdir(env.sessionPath(), { recursive: true });
      const { state, saveCreds } = await mod.useMultiFileAuthState(
        env.sessionPath(),
      );
      const makeSocket = mod.default ?? mod.makeWASocket;

      let version: import('@whiskeysockets/baileys').WAVersion | undefined;
      try {
        ({ version } = await mod.fetchLatestBaileysVersion());
      } catch {
        /* usa la versión por defecto de Baileys */
      }

      const sock = makeSocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: mod.Browsers?.macOS('Chrome') ?? [
          'BotAutomatizacion',
          'Chrome',
          '1.0.0',
        ],
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        if (generation === this.generation) void saveCreds();
      });
      sock.ev.on('connection.update', (update) => {
        if (generation === this.generation)
          void this.onConnectionUpdate(update);
      });
      sock.ev.on('messages.upsert', ({ messages }) => {
        if (generation === this.generation) void this.onMessages(messages);
      });

      this.logger.log(`Sesión cargada desde ${env.sessionPath()}`);
      return this.getStatus(true);
    } finally {
      this.starting = false;
    }
  }

  async send(to: string, text: string): Promise<{ ok: true; to: string }> {
    if (this.state !== 'connected' || !this.sock) {
      throw new ServiceUnavailableException('WhatsApp no está conectado');
    }
    const jid = toJid(to);
    await this.sock.sendMessage(jid, { text });
    this.logger.log(`Mensaje enviado a ${jid}`);
    return { ok: true, to: jid };
  }

  private async onConnectionUpdate(
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
        this.state = 'waiting_for_qr';
        this.logger.log(
          'QR listo: escanear desde WhatsApp > Dispositivos vinculados',
        );
      } catch (err) {
        this.logger.error(
          `No se pudo generar el QR: ${(err as Error).message}`,
        );
      }
    }

    if (connection === 'open') {
      this.state = 'connected';
      this.attempts = 0;
      const jid = this.sock?.user?.id ?? null;
      this.user = jid ? jid.split(':')[0] : null;
      this.qrDataUrl = null;
      this.logger.log(`Conectado como ${this.user ?? 'desconocido'}`);
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error as
        { output?: { statusCode?: number } } | undefined;
      const statusCode = error?.output?.statusCode;
      const loggedOut =
        statusCode === 401 ||
        statusCode === this.baileys?.DisconnectReason?.loggedOut;

      if (loggedOut) {
        this.state = 'disconnected';
        this.user = null;
        this.qrDataUrl = null;
        this.logger.warn(
          'Sesión cerrada por WhatsApp. Usa reconectar para generar un QR nuevo.',
        );
        return;
      }

      this.scheduleReconnect(statusCode);
    }
  }

  private scheduleReconnect(statusCode?: number): void {
    this.attempts += 1;
    const max = env.maxReconnectAttempts();

    if (this.attempts > max) {
      this.state = 'disconnected';
      this.logger.error(
        `Máximo de reintentos alcanzado (${max}). Usa reconectar.`,
      );
      return;
    }

    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts, 5));
    this.state = 'connecting';
    this.logger.warn(
      `Conexión cerrada (${statusCode ?? 'n/d'}), reintento ${this.attempts}/${max} en ${delay}ms`,
    );
    this.reconnectTimer = setTimeout(() => void this.start(), delay);
  }

  private isPnJid(jid: string | null | undefined): boolean {
    return !!jid && jid.endsWith('@s.whatsapp.net');
  }

  private async resolveSenderJid(
    jid: string,
    alt: string | undefined,
  ): Promise<string> {
    if (alt && this.isPnJid(alt)) return alt;
    if (this.isPnJid(jid)) return jid;

    for (const candidate of [jid, alt]) {
      if (!candidate || !candidate.endsWith('@lid')) continue;
      try {
        const pn =
          await this.sock?.signalRepository?.lidMapping?.getPNForLID(candidate);
        if (pn) return pn;
      } catch {
        /* sin mapping LID->PN */
      }
    }
    return jid;
  }

  private async onMessages(messages: WAMessage[]): Promise<void> {
    this.logger.log(`messages.upsert: ${messages.length} mensaje(s)`);
    for (const msg of messages) {
      const jid = msg.key.remoteJid ?? '';
      const body =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ??
        '';

      const chatType = jid.endsWith('@g.us') ? 'group' : 'direct';
      const senderJid =
        chatType === 'direct'
          ? await this.resolveSenderJid(jid, msg.key.remoteJidAlt)
          : jid;

      this.logger.log(
        `  <- jid=${jid || '(vacío)'} remitente=${senderJid || '(vacío)'} ` +
          `fromMe=${msg.key.fromMe === true} ` +
          `texto=${body ? JSON.stringify(body.slice(0, 60)) : 'sin texto'}`,
      );

      if (msg.key.fromMe) continue;
      if (!jid || jid === 'status@broadcast' || jid.includes('@newsletter'))
        continue;
      if (!body) continue;

      await this.handleInbound({
        id: msg.key.id ?? null,
        from: senderJid,
        fromNumber: normalizePhone(senderJid),
        body,
        timestamp: Number(msg.messageTimestamp ?? 0),
        chatType,
      });
    }
  }

  private async handleInbound(payload: InboundMessage): Promise<void> {
    const allowed = this.allowlist.allowed();
    const decision = decideAccess({
      chatType: payload.chatType,
      fromNumber: payload.fromNumber,
      allowed,
      allowGroups: env.allowGroups(),
    });
    if (decision === 'ignore') {
      const reason =
        payload.chatType === 'group' && !env.allowGroups()
          ? 'grupo'
          : 'no autorizado';
      this.logger.log(`Mensaje de ${payload.fromNumber} ignorado (${reason})`);
      return;
    }

    if (this.assistant.enabled) {
      const reply = await this.assistant.reply(payload);
      if (reply) {
        await this.sendReply(payload.from, reply);
        return;
      }
    }
    await this.forwardInbound(payload);
  }

  private async sendReply(jid: string, text: string): Promise<void> {
    if (this.state !== 'connected' || !this.sock) {
      this.logger.warn('No se pudo responder: WhatsApp no está conectado');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text });
      this.logger.log(`Respuesta enviada a ${jid}`);
    } catch (err) {
      this.logger.warn(
        `No se pudo enviar la respuesta a ${jid}: ${(err as Error).message}`,
      );
    }
  }

  private async forwardInbound(payload: InboundMessage): Promise<void> {
    const base = env.backend1BaseUrl();
    if (!base) return;

    const url = `${base.replace(/\/+$/, '')}${env.backend1InboundPath()}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = env.sharedToken();
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.warn(`Inbound reenviado con HTTP ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo reenviar inbound a backend 1: ${(err as Error).message}`,
      );
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function toJid(to: string): string {
  const value = to.trim();
  if (!value)
    throw new BadRequestException('El número de destino es obligatorio');
  if (value.includes('@')) return value;

  const digits = value.replace(/\D/g, '');
  if (digits.length < 8) {
    throw new BadRequestException(`Número inválido: ${to}`);
  }
  return `${digits}@s.whatsapp.net`;
}
