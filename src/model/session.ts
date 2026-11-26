import { randomBytes, createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Rol } from './user.js';

/** Duración de la sesión en días. */
export const DURACION_DIAS = 30;
/** Si al resolver quedan menos de estos días, se renueva (renovación deslizante). */
export const UMBRAL_RENOVACION_DIAS = 15;

const DIA_MS = 24 * 60 * 60 * 1000;

/** Identidad mínima autenticada que viaja por la capa de aplicación. */
export interface Actor {
  id: string;
  rol: Rol;
}

export interface SesionCreada {
  /** Token opaco en claro. Viaja SOLO en la cookie; nunca se persiste así. */
  token: string;
  expiresAt: Date;
}

export interface ResultadoResolver {
  actor: Actor;
  /** true si se aplicó renovación deslizante (el controlador debe reponer la cookie). */
  renovada: boolean;
  /** Caducidad vigente tras resolver (nueva si hubo renovación). */
  expiresAt: Date;
}

/**
 * Genera un token opaco de sesión: 32 bytes aleatorios criptográficamente
 * seguros en base64url. Prohibido usar uuid/relojes/PRNG no seguros (CLAUDE.md).
 */
export function generarToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) del token. Es lo único que se guarda en la BD, nunca el token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Crea una sesión para `userId`: genera el token, guarda SOLO su SHA-256 y fija
 * la caducidad a +30 días. Devuelve el token en claro (para la cookie) y la
 * caducidad.
 */
export async function crearSesion(sql: Sql, userId: string): Promise<SesionCreada> {
  const token = generarToken();
  const expiresAt = new Date(Date.now() + DURACION_DIAS * DIA_MS);
  await sql`
    insert into "Session" (user_id, token_sha256, expires_at)
    values (${userId}, ${hashToken(token)}, ${expiresAt})
  `;
  return { token, expiresAt };
}

/**
 * Resuelve una sesión a partir del token en claro.
 *
 * Devuelve `null` (y borra la fila si existía) cuando la sesión no existe, ha
 * caducado o su usuario ya no existe. Si es válida, devuelve el `Actor` y aplica
 * renovación deslizante: si quedan menos de `UMBRAL_RENOVACION_DIAS` días, amplía
 * la caducidad a +30 días y marca `renovada=true`.
 */
export async function resolverSesion(sql: Sql, token: string): Promise<ResultadoResolver | null> {
  const tokenSha = hashToken(token);

  const filas = await sql<{ id: string; user_id: string; rol: Rol; expires_at: Date }[]>`
    select s.id, s.user_id, u.rol, s.expires_at
    from "Session" s
    join "User" u on u.id = s.user_id
    where s.token_sha256 = ${tokenSha}
  `;
  const fila = filas[0];

  if (!fila) {
    // No existe, o el usuario ya no existe: borra cualquier fila por ese hash.
    await sql`delete from "Session" where token_sha256 = ${tokenSha}`;
    return null;
  }

  const ahora = Date.now();
  if (fila.expires_at.getTime() <= ahora) {
    await sql`delete from "Session" where id = ${fila.id}`;
    return null;
  }

  let expiresAt = fila.expires_at;
  let renovada = false;
  if (fila.expires_at.getTime() - ahora < UMBRAL_RENOVACION_DIAS * DIA_MS) {
    expiresAt = new Date(ahora + DURACION_DIAS * DIA_MS);
    await sql`update "Session" set expires_at = ${expiresAt} where id = ${fila.id}`;
    renovada = true;
  }

  return { actor: { id: fila.user_id, rol: fila.rol }, renovada, expiresAt };
}

/**
 * Borra la sesión asociada al token. Idempotente.
 * @returns `true` si existía y se borró, `false` si no había nada que borrar.
 */
export async function eliminarSesionPorToken(sql: Sql, token: string): Promise<boolean> {
  const borradas = await sql`delete from "Session" where token_sha256 = ${hashToken(token)}`;
  return borradas.count > 0;
}
