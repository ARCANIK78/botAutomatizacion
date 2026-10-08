import {
  normalizeBolivianPhone,
  normalizePhone,
  parsePhoneList,
} from './phone';

describe('normalizePhone', () => {
  it('quita el símbolo +, espacios y guiones', () => {
    expect(normalizePhone('+591 728-30478')).toBe('59172830478');
  });

  it('quita el sufijo de dispositivo y el dominio', () => {
    expect(normalizePhone('59172830478:24@s.whatsapp.net')).toBe('59172830478');
  });

  it('quita el dominio de WhatsApp', () => {
    expect(normalizePhone('59172830478@s.whatsapp.net')).toBe('59172830478');
  });
});

describe('parsePhoneList', () => {
  it('normaliza y separa por comas', () => {
    expect(parsePhoneList('+591 728-30478, 59171234567')).toEqual([
      '59172830478',
      '59171234567',
    ]);
  });

  it('devuelve lista vacía para valores vacíos', () => {
    expect(parsePhoneList('')).toEqual([]);
    expect(parsePhoneList(undefined)).toEqual([]);
  });
});

describe('normalizeBolivianPhone', () => {
  it('normaliza un móvil boliviano con código de país', () => {
    expect(normalizeBolivianPhone('+591 72830478')).toBe('59172830478');
    expect(normalizeBolivianPhone('59172830478')).toBe('59172830478');
  });

  it('agrega el código de país si falta', () => {
    expect(normalizeBolivianPhone('72830478')).toBe('59172830478');
    expect(normalizeBolivianPhone('61234567')).toBe('59161234567');
  });

  it('rechaza números que no son móviles bolivianos', () => {
    expect(normalizeBolivianPhone('123')).toBeNull();
    expect(normalizeBolivianPhone('59112345678')).toBeNull();
    expect(normalizeBolivianPhone('+54 11 5555 5555')).toBeNull();
  });
});
