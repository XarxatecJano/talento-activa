import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';
import { DatosInvalidosError } from './errors.js';

/** Longitud mínima y máxima de contraseña (invariante de seguridad, CLAUDE.md). */
export const LONGITUD_MIN = 12;
export const LONGITUD_MAX = 256;

// Algorithm es un `const enum`: con verbatimModuleSyntax no puede importarse como
// valor, así que usamos su valor numérico (Argon2id = 2) tipado como Algorithm.
const ARGON2ID = 2 as Algorithm;

/** Parámetros Argon2id fijados por el cliente: m=19456, t=2, p=1. */
const OPCIONES_ARGON2 = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Valida la longitud de la contraseña.
 * @throws {DatosInvalidosError} si está fuera del rango [LONGITUD_MIN, LONGITUD_MAX].
 */
export function validarLongitudPassword(password: string): void {
  if (password.length < LONGITUD_MIN || password.length > LONGITUD_MAX) {
    throw new DatosInvalidosError(
      `La contraseña debe tener entre ${LONGITUD_MIN} y ${LONGITUD_MAX} caracteres.`,
    );
  }
}

/**
 * Calcula el hash Argon2id de una contraseña. Valida la longitud antes de hashear.
 * @throws {DatosInvalidosError} si la longitud está fuera de rango.
 */
export async function hashPassword(password: string): Promise<string> {
  validarLongitudPassword(password);
  return argon2Hash(password, OPCIONES_ARGON2);
}

/**
 * Verifica una contraseña contra su hash Argon2id almacenado.
 * Devuelve `false` si no coinciden; no valida longitud (una contraseña errónea
 * debe dar `false`, no lanzar).
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2Verify(hash, password);
}
