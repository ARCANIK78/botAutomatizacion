import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';
import { Backend1AuthService } from '../common/backend1-auth.service';

export interface Empresa {
  id: string;
  nombre: string;
  telefono?: string;
}

@Injectable()
export class EmpresasService {
  private readonly logger = new Logger(EmpresasService.name);

  constructor(private readonly backend1: Backend1AuthService) {}

  async listar(): Promise<Empresa[]> {
    const base = env.empresasBackendUrl();
    if (!base) {
      this.logger.warn(
        'EMPRESAS_BACKEND_URL no configurado; retornando lista vacía',
      );
      return [];
    }
    if (!this.backend1.getToken()) {
      this.logger.warn(
        'Sin token de Backend 1 (BACKEND1_SHARED_TOKEN vacío y CONTABILY_* sin configurar); no se puede autenticar',
      );
      return [];
    }

    const url = `${base.replace(/\/+$/, '')}/api/v1/empresas`;
    try {
      // El presupuesto cubre el login + la consulta: con Render dormido el
      // primer arranque tarda varios segundos, y fallar ahí vaciaba el panel.
      const res = await this.backend1.fetchWithAuth(url, {
        signal: AbortSignal.timeout(env.backend1StartupTimeoutMs()),
      });
      if (!res.ok) {
        this.logger.warn(`Backend empresas respondió HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as Empresa[] | { data?: Empresa[] };
      const list = Array.isArray(data) ? data : data.data ?? [];
      return list.map((e) => ({
        id: String(e.id),
        nombre: e.nombre,
        telefono: e.telefono,
      }));
    } catch (err) {
      this.logger.warn(
        `No se pudo consultar empresas: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
