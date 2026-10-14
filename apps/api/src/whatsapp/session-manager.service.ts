import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { AssistantService } from '../assistant/assistant.service';
import { AllowlistService } from './allowlist.service';
import { EmpresasService } from '../empresas/empresas.service';
import { Backend1AuthService } from '../common/backend1-auth.service';
import { SessionStorageService } from '../common/session-storage.service';

export interface SessionInfo {
  empresaId: string;
  empresaNombre: string;
  state: string;
  qr: string | null;
  user: string | null;
  at: number;
}

@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);
  private sessions = new Map<string, WhatsappService>();

  constructor(
    private readonly assistant: AssistantService,
    private readonly allowlist: AllowlistService,
    private readonly empresas: EmpresasService,
    private readonly backend1: Backend1AuthService,
    private readonly sessionStorage: SessionStorageService,
  ) {}

  getOrCreate(empresaId: string, empresaNombre: string): WhatsappService {
    let session = this.sessions.get(empresaId);
    if (!session) {
      session = new WhatsappService(
        this.assistant,
        this.allowlist,
        this.backend1,
        this.sessionStorage,
      );
      session.setEmpresaId(empresaId);
      session.setEmpresaNombre(empresaNombre);
      this.sessions.set(empresaId, session);
      this.logger.log(`Sesión creada para empresa ${empresaId} (${empresaNombre})`);
    }
    return session;
  }

  get(empresaId: string): WhatsappService | undefined {
    return this.sessions.get(empresaId);
  }

  list(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const [id, session] of this.sessions) {
      const status = session.getStatus(false);
      result.push({
        empresaId: id,
        empresaNombre: session.getEmpresaNombre(),
        state: status.state,
        qr: status.qr,
        user: status.user,
        at: status.at,
      });
    }
    return result;
  }

  remove(empresaId: string): boolean {
    const session = this.sessions.get(empresaId);
    if (!session) return false;
    session.destroy();
    this.sessions.delete(empresaId);
    this.logger.log(`Sesión eliminada para empresa ${empresaId}`);
    return true;
  }

  has(empresaId: string): boolean {
    return this.sessions.has(empresaId);
  }

  async startSession(empresaId: string, empresaNombre: string): Promise<void> {
    const session = this.getOrCreate(empresaId, empresaNombre);

    // Configurar callback para validar cuando se conecte
    session.setOnConnected(async (connectedUser: string) => {
      await this.validatePhoneNumber(empresaId, connectedUser);
    });

    await session.start();
  }

  private async validatePhoneNumber(empresaId: string, connectedUser: string): Promise<void> {
    try {
      const empresasList = await this.empresas.listar();
      const empresa = empresasList.find((e) => e.id === empresaId);
      if (!empresa || !(empresa as any).telefono) return; // No hay teléfono configurado, no validar

      const expectedPhone = (empresa as any).telefono.replace(/\D/g, '');
      const connectedPhone = connectedUser.replace(/\D/g, '');

      if (connectedPhone && expectedPhone !== connectedPhone) {
        this.logger.error(
          `Número no coincide para empresa ${empresaId}: esperado ${expectedPhone}, conectado ${connectedPhone}`,
        );
        const session = this.sessions.get(empresaId);
        if (session) {
          session.destroy();
          this.sessions.delete(empresaId);
        }
        throw new BadRequestException(
          `El número de WhatsApp conectado (${connectedPhone}) no coincide con el teléfono de la empresa (${expectedPhone}). ` +
          `Escanea el QR con el número correcto.`,
        );
      }

      if (connectedPhone) {
        this.logger.log(`Número validado para empresa ${empresaId}: ${connectedPhone}`);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`No se pudo validar teléfono para ${empresaId}: ${(err as Error).message}`);
    }
  }
}
