import { BadRequestException } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';

describe('AllowlistService', () => {
  let service: AllowlistService;

  beforeEach(() => {
    service = new AllowlistService();
    delete process.env.WHATSAPP_ALLOWED_NUMBERS;
  });

  afterEach(() => {
    delete process.env.WHATSAPP_ALLOWED_NUMBERS;
  });

  it('agrega un número boliviano normalizado', () => {
    const list = service.add('+591 72830478');
    expect(list).toEqual([{ number: '59172830478', source: 'runtime' }]);
  });

  it('acepta el número sin código de país', () => {
    const list = service.add('72830478');
    expect(service.allowed()).toEqual(['59172830478']);
    expect(list).toHaveLength(1);
  });

  it('rechaza números no bolivianos o inválidos', () => {
    expect(() => service.add('123')).toThrow(BadRequestException);
    expect(() => service.add('59112345678')).toThrow(BadRequestException);
    expect(() => service.add('+54 11 5555 5555')).toThrow(BadRequestException);
  });

  it('quita números agregados en runtime', () => {
    service.add('72830478');
    const list = service.remove('59172830478');
    expect(list).toHaveLength(0);
    expect(service.allowed()).toEqual([]);
  });

  it('combina la lista de entorno con la de runtime', () => {
    process.env.WHATSAPP_ALLOWED_NUMBERS = '71234567';
    service.add('72830478');

    expect(service.allowed().sort()).toEqual(['59171234567', '59172830478']);
    expect(service.list()).toContainEqual({
      number: '59171234567',
      source: 'env',
    });
  });

  it('no permite quitar números definidos por entorno', () => {
    process.env.WHATSAPP_ALLOWED_NUMBERS = '71234567';
    expect(() => service.remove('71234567')).toThrow(BadRequestException);
  });
});
