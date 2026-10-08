import { BadRequestException, Injectable } from '@nestjs/common';
import { normalizeBolivianPhone, normalizePhone } from '../common/phone';
import { env } from '../config';

export interface AllowlistEntry {
  number: string;
  source: 'env' | 'runtime';
}

@Injectable()
export class AllowlistService {
  private readonly runtime = new Set<string>();

  allowed(): string[] {
    return [...new Set([...this.envNumbers(), ...this.runtime])];
  }

  list(): AllowlistEntry[] {
    const envNumbers = this.envNumbers();
    const entries: AllowlistEntry[] = envNumbers.map((number) => ({
      number,
      source: 'env',
    }));
    for (const number of this.runtime) {
      if (!envNumbers.includes(number)) {
        entries.push({ number, source: 'runtime' });
      }
    }
    return entries;
  }

  add(raw: string): AllowlistEntry[] {
    const number = normalizeBolivianPhone(raw ?? '');
    if (!number) {
      throw new BadRequestException(
        'Ingresa un número boliviano válido (ej. 72830478 o +591 72830478)',
      );
    }
    this.runtime.add(number);
    return this.list();
  }

  remove(raw: string): AllowlistEntry[] {
    const number =
      normalizeBolivianPhone(raw ?? '') ?? normalizePhone(raw ?? '');
    if (this.envNumbers().includes(number)) {
      throw new BadRequestException(
        'Ese número está definido en WHATSAPP_ALLOWED_NUMBERS y no se puede quitar desde el panel',
      );
    }
    this.runtime.delete(number);
    return this.list();
  }

  private envNumbers(): string[] {
    return env
      .allowedNumbers()
      .map((number) => normalizeBolivianPhone(number))
      .filter((number): number is string => number !== null);
  }
}
