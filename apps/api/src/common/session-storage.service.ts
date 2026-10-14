import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';

/**
 * Diagnóstico del almacenamiento de la sesión de WhatsApp.
 *
 * Render descarta el filesystem en cada deploy y en cada reinicio del free
 * tier. La sesión de Baileys solo sobrevive si WHATSAPP_SESSION_PATH apunta a
 * un Persistent Disk adjunto al servicio.
 *
 * No se infiere por el nombre de la ruta (Render permite declarar /data sin
 * adjuntar disco, y una ruta relativa puede caer dentro de un disco montado).
 * En su lugar se comprueba empíricamente, escribiendo y borrando un fichero
 * de prueba: es la única señal que distingue con certeza un disco efímero de
 * uno persistente.
 */
@Injectable()
export class SessionStorageService {
  private readonly logger = new Logger(SessionStorageService.name);
  private warned = false;
  private persistente: boolean | null = null;

  /**
   * Comprueba si la ruta de sesión sobrevive a un reinicio, escribiendo un
   * fichero temporal y verificando que sigue ahí. Cachea el resultado: la
   * respuesta no cambia durante la vida del proceso.
   */
  async esPersistente(): Promise<boolean> {
    if (this.persistente !== null) return this.persistente;

    const base = env.sessionBase();
    const marca = join(base, '.persist-check');
    const contenido = String(Date.now());

    try {
      await mkdir(dirname(marca), { recursive: true });
      await writeFile(marca, contenido);
      const leido = await readFile(marca, 'utf8');
      await rm(marca, { force: true });

      // Un disco de solo lectura (mal montado) permite leer pero no escribir
      // de forma fiable; se considera no persistente porque Baileys no podrá
      // guardar las credenciales.
      this.persistente = leido === contenido;
    } catch {
      // La ruta no existe todavía o no admite escritura: en el primer
      // arranque es esperado, pero no se puede prometer persistencia.
      this.persistente = false;
    }

    return this.persistente;
  }

  /**
   * Describe el estado del almacenamiento. Como la comprobación real es
   * asíncrona, se puede forzar con `esPersistente()` antes de llamar.
   */
  check(persistente: boolean): { persistente: boolean; path: string; detalle: string } {
    const base = env.sessionBase();
    const enRender = process.env.RENDER === 'true';
    const declarada = env.sessionPathExplicit();

    if (!declarada) {
      return {
        persistente: false,
        path: base,
        detalle:
          'WHATSAPP_SESSION_PATH sin configurar: se usa una ruta relativa dentro del filesystem efímero. La sesión se pierde en cada deploy.',
      };
    }

    if (persistente) {
      return {
        persistente: true,
        path: base,
        detalle: `Sesión en ${base}: la ruta admite escritura y sobrevive a redeploys.`,
      };
    }

    return {
      persistente: false,
      path: base,
      detalle: enRender
        ? `WHATSAPP_SESSION_PATH=${base} no admite persistencia. En Render esa ruta se borra en cada deploy: habrá que escanear el QR de nuevo.`
        : `WHATSAPP_SESSION_PATH=${base} no admite escritura: Baileys no podrá guardar la sesión.`,
    };
  }

  /** Log una sola vez al arrancar, para que el motivo sea visible. */
  async logAlArrancar(): Promise<void> {
    if (this.warned) return;
    this.warned = true;

    const persistente = await this.esPersistente();
    const status = this.check(persistente);

    if (status.persistente) {
      this.logger.log(status.detalle);
    } else {
      this.logger.warn(status.detalle);
    }
  }
}
