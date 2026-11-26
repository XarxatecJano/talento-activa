import { describe, it, expect, vi } from 'vitest';
import {
  NOMBRE_COOKIE,
  construirCookieSesion,
  construirCookieBorrado,
  leerTokenCookie,
  esProduccion,
} from '../../src/controller/cookie.js';

const EXP = new Date('2026-12-25T10:00:00.000Z');

describe('controller/cookie — construirCookieSesion', () => {
  it('incluye nombre=token y los flags obligatorios con Expires absoluto', () => {
    const c = construirCookieSesion('TOKEN123', EXP, false);
    expect(c.startsWith(`${NOMBRE_COOKIE}=TOKEN123;`)).toBe(true);
    expect(c).toContain('Path=/');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain(`Expires=${EXP.toUTCString()}`);
  });

  it('NO usa Max-Age (se usa Expires absoluto)', () => {
    expect(construirCookieSesion('T', EXP, true)).not.toMatch(/Max-Age/i);
  });

  it('añade Secure solo cuando secure=true', () => {
    expect(construirCookieSesion('T', EXP, true)).toContain('Secure');
    expect(construirCookieSesion('T', EXP, false)).not.toContain('Secure');
  });
});

describe('controller/cookie — construirCookieBorrado', () => {
  it('vacía el valor y expira en el epoch, manteniendo los flags', () => {
    const c = construirCookieBorrado(false);
    expect(c.startsWith(`${NOMBRE_COOKIE}=;`)).toBe(true);
    expect(c).toContain('Path=/');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain(`Expires=${new Date(0).toUTCString()}`);
  });

  it('respeta Secure', () => {
    expect(construirCookieBorrado(true)).toContain('Secure');
    expect(construirCookieBorrado(false)).not.toContain('Secure');
  });
});

describe('controller/cookie — leerTokenCookie', () => {
  it('extrae el token de la cabecera Cookie', () => {
    expect(leerTokenCookie(`a=1; ${NOMBRE_COOKIE}=XYZ; b=2`)).toBe('XYZ');
    expect(leerTokenCookie(`${NOMBRE_COOKIE}=solo`)).toBe('solo');
  });

  it('devuelve null si no está, está vacía o la cabecera falta', () => {
    expect(leerTokenCookie('a=1; b=2')).toBeNull();
    expect(leerTokenCookie(`${NOMBRE_COOKIE}=`)).toBeNull();
    expect(leerTokenCookie(null)).toBeNull();
    expect(leerTokenCookie(undefined)).toBeNull();
  });
});

describe('controller/cookie — esProduccion', () => {
  it('true solo con NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(esProduccion()).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect(esProduccion()).toBe(false);
    vi.unstubAllEnvs();
  });
});
