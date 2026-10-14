import { BadRequestException, Injectable } from '@nestjs/common';
import { normalizeBolivianPhone, normalizePhone } from '../common/phone';
import { env } from '../config';

export interface AllowlistEntry {
  number: string;
  source: 'env' | 'runtime';
}

@Injectable()
export class AllowlistService {
  // runtime[empresaId] = Set<números>
  private readonly runtime = new Map<string, Set<string>>();

  allowed(empresaId?: string): string[] {
    const envNumbers = this.envNumbers();
    if (!empresaId) {
      // Global: todas las empresas
      const all = new Set(envNumbers);
      for (const numbers of this.runtime.values()) {
        for (const n of numbers) all.add(n);
      }
      return [...all];
    }
    const company = this.runtime.get(empresaId) ?? new Set<string>();
    return [...new Set([...envNumbers, ...company])];
  }

  list(empresaId?: string): AllowlistEntry[] {
    const envNumbers = this.envNumbers();
    const entries: AllowlistEntry[] = envNumbers.map((number) => ({
      number,
      source: 'env',
    }));

    if (empresaId) {
      const company = this.runtime.get(empresaId) ?? new Set<string>();
      for (const number of company) {
        if (!envNumbers.includes(number)) {
          entries.push({ number, source: 'runtime' });
        }
      }
    } else {
      // Global: listar todos los runtime de todas las empresas
      for (const [eid, numbers] of this.runtime) {
        for (const number of numbers) {
          if (!envNumbers.includes(number)) {
            entries.push({ number, source: 'runtime' });
          }
        }
      }
    }
    return entries;
  }

  add(raw: string, empresaId?: string): AllowlistEntry[] {
    const number = normalizeBolivianPhone(raw ?? '');
    if (!number) {
      throw new BadRequestException(
        'Ingresa un número boliviano válido (ej. 72830478 o +591 72830478)',
      );
    }
    const key = empresaId ?? 'global';
    if (!this.runtime.has(key)) {
      this.runtime.set(key, new Set());
    }
    this.runtime.get(key)!.add(number);
    return this.list(empresaId);
  }

  remove(raw: string, empresaId?: string): AllowlistEntry[] {
    const number =
      normalizeBolivianPhone(raw ?? '') ?? normalizePhone(raw ?? '');
    if (this.envNumbers().includes(number)) {
      throw new BadRequestException(
        'Ese número está definido en WHATSAPP_ALLOWED_NUMBERS y no se puede quitar desde el panel',
      );
    }
    const key = empresaId ?? 'global';
    const company = this.runtime.get(key);
    if (company) {
      company.delete(number);
      if (company.size === 0) {
        this.runtime.delete(key);
      }
    }
    return this.list(empresaId);
  }

  private envNumbers(): string[] {
    return env
      .allowedNumbers()
      .map((number) => normalizeBolivianPhone(number))
      .filter((number): number is string => number !== null);
  }
}
