import { stat } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';

/**
 * Diagnóstico del almacenamiento de la sesión de WhatsApp.
 *
 * Render descarta el filesystem en cada deploy y en cada reinicio del free
 * tier. La sesión de Baileys solo sobrevive si WHATSAPP_SESSION_PATH apunta a
 * un Persistent Disk adjunto al servicio.
 *
 * La persistencia NO se puede probar escribiendo un fichero y volviendo a
 * leerlo: el filesystem efímero de Render admite escritura y lectura sin
 * problema, y el fichero desaparece recién en el próximo deploy. Esa
 * comprobación pasa igual en un disco efímero y da falsa confianza.
 *
 * Lo único que distingue ambos casos es el sistema de ficheros subyacente.
 * Render monta los Persistent Disks en su propio dispositivo, separado del
 * que contiene el código de la aplicación. Se comparan los dispositivos con
 * stat().dev. Por eso se mide el dispositivo, no se escribe nada.
 */
@Injectable()
export class SessionStorageService {
  private readonly logger = new Logger(SessionStorageService.name);
  private warned = false;
  private persistencia: { persistente: boolean; detalle: string } | null = null;

  /**
   * true solo si la ruta de sesión vive en un dispositivo distinto al del
   * código de la aplicación. Cachea el resultado: el disco no cambia durante
   * la vida del proceso.
   */
  async esPersistente(): Promise<boolean> {
    return (await this.diagnosticar()).persistente;
  }

  private async diagnosticar(): Promise<{ persistente: boolean; detalle: string }> {
    if (this.persistencia) return this.persistencia;

    const base = env.sessionBase();
    const enRender = process.env.RENDER === 'true';

    if (!env.sessionPathExplicit()) {
      return (this.persistencia = {
        persistente: false,
        detalle:
          'WHATSAPP_SESSION_PATH sin configurar: se usa una ruta relativa dentro del filesystem efímero. La sesión se pierde en cada deploy.',
      });
    }

    let sesionDev: number;
    let codigoDev: number;
    try {
      const [s, c] = await Promise.all([stat(base), stat(process.cwd())]);
      sesionDev = Number(s.dev);
      codigoDev = Number(c.dev);
    } catch (err) {
      // La ruta no existe todavía: es esperado en el primer arranque. Sin
      // poder medirla no se puede afirmar que sea persistente.
      return (this.persistencia = {
        persistente: false,
        detalle: `No se pudo medir ${base}: ${(err as Error).message}. Si es el primer arranque, la sesión se creará al conectar.`,
      });
    }

    // Mismo dispositivo => está en el filesystem de la aplicación, que en
    // Render se reconstruye entero en cada deploy.
    const persistente = enRender && sesionDev !== codigoDev;

    this.persistencia = {
      persistente,
      detalle: persistente
        ? `Sesión en ${base} (dispositivo ${sesionDev}, separado del código en ${codigoDev}): sobrevive a redeploys.`
        : enRender
          ? `WHATSAPP_SESSION_PATH=${base} está en el mismo disco que la aplicación (dispositivo ${sesionDev}), no en un Persistent Disk. En Render esa ruta se borra en cada deploy: habrá que escanear el QR de nuevo.`
          : `WHATSAPP_SESSION_PATH=${base} (entorno local, dispositivo ${sesionDev}): la sesión se guarda en tu disco.`,
    };
    return this.persistencia;
  }

  /** Estado para /api/health y los logs. */
  async check(): Promise<{ persistente: boolean; path: string; detalle: string }> {
    const { detalle } = await this.diagnosticar();
    return {
      persistente: this.persistencia?.persistente ?? false,
      path: env.sessionBase(),
      detalle,
    };
  }

  /** Log una sola vez al arrancar, para que el motivo sea visible. */
  async logAlArrancar(): Promise<void> {
    if (this.warned) return;
    this.warned = true;

    const status = await this.check();
    if (status.persistente) {
      this.logger.log(status.detalle);
    } else {
      this.logger.warn(status.detalle);
    }
  }
}
