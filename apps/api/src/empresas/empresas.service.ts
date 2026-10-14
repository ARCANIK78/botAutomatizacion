import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';

export interface Empresa {
  id: string;
  nombre: string;
  telefono?: string;
}

@Injectable()
export class EmpresasService {
  private readonly logger = new Logger(EmpresasService.name);

  async listar(): Promise<Empresa[]> {
    const base = env.empresasBackendUrl();
    const token = env.sharedToken();
    if (!base) {
      this.logger.warn(
        'EMPRESAS_BACKEND_URL no configurado; retornando lista vacía',
      );
      return [];
    }
    if (!token) {
      this.logger.warn(
        'BACKEND1_SHARED_TOKEN no configurado; no se puede autenticar con Backend 1',
      );
      return [];
    }

    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1/empresas`, {
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
