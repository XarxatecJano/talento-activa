import type { Sql } from 'postgres';
import { generarToken, hashToken } from './session.js';
import { registrarAuditoria } from './audit.js';

/** Validez del token de verificación de email (horas). */
export const DURACION_VERIFICACION_HORAS = 24;
const HORA_MS = 60 * 60 * 1000;

export interface TokenVerificacion {
  /** Token opaco en claro (viaja en el enlace del email; nunca se persiste así). */
  token: string;
  expiresAt: Date;
}

/**
 * Crea un token de verificación de email de un solo uso para `userId`. Guarda
 * solo el SHA-256 y fija la caducidad. Devuelve el token en claro para el email.
 */
export async function crearTokenVerificacion(sql: Sql, userId: string): Promise<TokenVerificacion> {
  const token = generarToken();
  const expiresAt = new Date(Date.now() + DURACION_VERIFICACION_HORAS * HORA_MS);
  await sql`
    insert into "Email_verification_token" (user_id, token_sha256, expires_at)
    values (${userId}, ${hashToken(token)}, ${expiresAt})
  `;
  return { token, expiresAt };
}

/**
 * Consume un token de verificación. Si es válido (existe, no usado, no caducado),
 * marca el token como usado, pone `email_verified=true` en el usuario y audita el
 * cambio, todo en una transacción. De un solo uso.
 *
 * @returns `true` si se verificó; `false` si el token no es válido.
 */
export async function verificarEmail(sql: Sql, token: string): Promise<boolean> {
  const tokenSha = hashToken(token);
  return await sql.begin(async (tx) => {
    const filas = await tx<{ id: string; user_id: string }[]>`
      select id, user_id from "Email_verification_token"
      where token_sha256 = ${tokenSha} and used_at is null and expires_at > now()
      for update
    `;
    const fila = filas[0];
    if (!fila) return false;

    await tx`update "Email_verification_token" set used_at = now() where id = ${fila.id}`;
    await tx`update "User" set email_verified = true where id = ${fila.user_id}`;
    await registrarAuditoria(tx, {
      idUsuario: fila.user_id,
      tabla: 'User',
      idRegistro: fila.user_id,
      operacion: 'UPDATE',
      datosNuevos: { email_verified: true },
    });
    return true;
  });
}
