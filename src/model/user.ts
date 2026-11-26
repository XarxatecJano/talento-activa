import type { Sql } from 'postgres';
import { hashPassword } from './password.js';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError, EmailYaRegistradoError } from './errors.js';

export type Rol = 'ADMIN' | 'SOCIO' | 'ALUMNO';

/** Proyección pública de un usuario: nunca incluye `password_hash`. */
export interface UsuarioPublico {
  id: string;
  email: string;
  rol: Rol;
  email_verified: boolean;
  created_at: Date;
}

export interface DatosNuevoUsuario {
  email: string;
  password: string;
  rol: Rol;
}

/** Código SQLSTATE de violación de restricción única en Postgres. */
const UNIQUE_VIOLATION = '23505';

/**
 * Normaliza y valida mínimamente un email: recorta espacios y exige un '@'.
 * No altera mayúsculas/minúsculas (la unicidad es case-insensitive por el índice
 * `lower(email)` de la BD).
 * @throws {DatosInvalidosError} si queda vacío o no contiene '@'.
 */
export function normalizarEmail(email: string): string {
  const limpio = email.trim();
  if (limpio.length === 0 || !limpio.includes('@')) {
    throw new DatosInvalidosError('Email no válido.');
  }
  return limpio;
}

/** Credenciales internas para login: incluye el hash (nunca sale al exterior). */
export interface Credenciales {
  id: string;
  rol: Rol;
  password_hash: string;
}

/**
 * Busca las credenciales de login por email (case-insensitive, `lower(email)`).
 * No lanza ante email vacío/mal formado: devuelve `null` para no filtrar, por
 * tiempos ni por error, si una cuenta existe (anti-enumeración).
 */
export async function buscarCredencialesPorEmail(sql: Sql, email: string): Promise<Credenciales | null> {
  const limpio = email.trim();
  if (limpio.length === 0) return null;
  const filas = await sql<Credenciales[]>`
    select id, rol, password_hash from "User" where lower(email) = lower(${limpio})
  `;
  return filas[0] ?? null;
}

function esViolacionUnicidad(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Alta de usuario por invitación. Hashea la contraseña, inserta el usuario
 * (`email_verified` arranca en false por defecto) y audita el INSERT en la misma
 * transacción. Devuelve la proyección pública (sin hash).
 *
 * @param idActor Usuario que realiza el alta (admin que invita); `null` si lo
 *   genera el sistema (p. ej. bootstrap).
 * @throws {DatosInvalidosError} email inválido o contraseña fuera de rango.
 * @throws {EmailYaRegistradoError} si el email ya existe (case-insensitive).
 */
export async function crearUsuario(
  sql: Sql,
  datos: DatosNuevoUsuario,
  idActor: string | null = null,
): Promise<UsuarioPublico> {
  const email = normalizarEmail(datos.email);
  const passwordHash = await hashPassword(datos.password);

  try {
    const usuario = await sql.begin(async (tx) => {
      const filas = await tx<UsuarioPublico[]>`
        insert into "User" (email, password_hash, rol)
        values (${email}, ${passwordHash}, ${datos.rol})
        returning id, email, rol, email_verified, created_at
      `;
      const creado = filas[0]!;
      await registrarAuditoria(tx, {
        idUsuario: idActor,
        tabla: 'User',
        idRegistro: creado.id,
        operacion: 'INSERT',
        datosNuevos: {
          email: creado.email,
          rol: creado.rol,
          email_verified: creado.email_verified,
        },
      });
      return creado;
    });
    return usuario as UsuarioPublico;
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new EmailYaRegistradoError();
    }
    throw err;
  }
}
