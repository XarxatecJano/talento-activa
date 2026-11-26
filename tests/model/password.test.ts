import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, LONGITUD_MIN, LONGITUD_MAX } from '../../src/model/password.js';
import { DatosInvalidosError } from '../../src/model/errors.js';

const VALIDA = 'contraseña-segura-123';

describe('model/password — hashPassword / verifyPassword', () => {
  it('genera un hash Argon2id con los parámetros m=19456,t=2,p=1', async () => {
    const h = await hashPassword(VALIDA);
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).toContain('m=19456,t=2,p=1');
  });

  it('verifica correctamente la contraseña buena y rechaza la mala', async () => {
    const h = await hashPassword(VALIDA);
    await expect(verifyPassword(h, VALIDA)).resolves.toBe(true);
    await expect(verifyPassword(h, 'incorrecta-xxxxx')).resolves.toBe(false);
  });

  it('usa sal aleatoria: dos hashes de la misma contraseña difieren y ambos verifican', async () => {
    const h1 = await hashPassword(VALIDA);
    const h2 = await hashPassword(VALIDA);
    expect(h1).not.toBe(h2);
    await expect(verifyPassword(h1, VALIDA)).resolves.toBe(true);
    await expect(verifyPassword(h2, VALIDA)).resolves.toBe(true);
  });
});

describe('model/password — validación de longitud (12–256)', () => {
  it('lanza DatosInvalidosError si es más corta que el mínimo', async () => {
    await expect(hashPassword('a'.repeat(LONGITUD_MIN - 1))).rejects.toBeInstanceOf(DatosInvalidosError);
  });

  it('lanza DatosInvalidosError si es más larga que el máximo', async () => {
    await expect(hashPassword('a'.repeat(LONGITUD_MAX + 1))).rejects.toBeInstanceOf(DatosInvalidosError);
  });

  it('acepta los límites exactos (12 y 256)', async () => {
    const min = await hashPassword('a'.repeat(LONGITUD_MIN));
    const max = await hashPassword('a'.repeat(LONGITUD_MAX));
    await expect(verifyPassword(min, 'a'.repeat(LONGITUD_MIN))).resolves.toBe(true);
    await expect(verifyPassword(max, 'a'.repeat(LONGITUD_MAX))).resolves.toBe(true);
  });
});
