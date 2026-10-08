export function normalizePhone(value: string): string {
  const withoutDevice = value.split(':')[0] ?? value;
  const withoutDomain = withoutDevice.split('@')[0] ?? withoutDevice;
  return withoutDomain.replace(/\D/g, '');
}

export function parsePhoneList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => normalizePhone(item))
    .filter((item) => item.length > 0);
}

export function normalizeBolivianPhone(value: string): string | null {
  const digits = normalizePhone(value);
  const local = digits.startsWith('591') ? digits.slice(3) : digits;
  if (!/^[67]\d{7}$/.test(local)) return null;
  return `591${local}`;
}
