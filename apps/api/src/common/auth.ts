import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../config';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(authorization?: string): string {
  return (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}

export function isAdminRequest(
  xAdminToken?: string,
  authorization?: string,
): boolean {
  const expected = env.adminToken();
  if (!expected) return true;
  const given = (xAdminToken ?? '').trim() || bearerToken(authorization);
  return given.length > 0 && safeEqual(given, expected);
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { headers?: { [key: string]: unknown } }>();
    const xAdminToken =
      typeof request.headers?.['x-admin-token'] === 'string'
        ? request.headers['x-admin-token']
        : '';
    const authorization =
      typeof request.headers?.authorization === 'string'
        ? request.headers.authorization
        : '';
    const ok = isAdminRequest(xAdminToken, authorization);
    if (!ok) throw new UnauthorizedException('Token admin inválido');
    return true;
  }
}
