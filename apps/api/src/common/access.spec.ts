import { decideAccess } from './access';

describe('decideAccess', () => {
  it('ignora grupos por defecto', () => {
    expect(
      decideAccess({
        chatType: 'group',
        fromNumber: '59172830478',
        allowed: ['59172830478'],
        allowGroups: false,
      }),
    ).toBe('ignore');
  });

  it('permite grupos si allowGroups es true y el número está autorizado', () => {
    expect(
      decideAccess({
        chatType: 'group',
        fromNumber: '59172830478',
        allowed: ['59172830478'],
        allowGroups: true,
      }),
    ).toBe('allow');
  });

  it('permite a todos los directos si la lista está vacía', () => {
    expect(
      decideAccess({
        chatType: 'direct',
        fromNumber: '59172830478',
        allowed: [],
        allowGroups: false,
      }),
    ).toBe('allow');
  });

  it('ignora directos de números no listados', () => {
    expect(
      decideAccess({
        chatType: 'direct',
        fromNumber: '59170000000',
        allowed: ['59172830478'],
        allowGroups: false,
      }),
    ).toBe('ignore');
  });

  it('permite directos de números autorizados', () => {
    expect(
      decideAccess({
        chatType: 'direct',
        fromNumber: '59172830478',
        allowed: ['59172830478'],
        allowGroups: false,
      }),
    ).toBe('allow');
  });
});
