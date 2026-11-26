import type { Sql } from 'postgres';
import { buscarCredencialesPorEmail } from '../model/user.js';
import type { Rol } from '../model/user.js';
import { verifyPassword, hashSenuelo } from '../model/password.js';

export interface IdentidadAutenticada {
  id: string;
  rol: Rol;
}

/**
 * Autentica unas credenciales. Devuelve la identidad si son válidas, o `null`.
 *
 * Anti-enumeración: si el email no existe, se verifica la contraseña contra un
 * hash señuelo para que el coste temporal sea equivalente al de un email que sí
 * existe con contraseña incorrecta. El resultado (null) es idéntico en ambos
 * casos (mismo error, mismo estado, mismo tiempo).
 */
export async function autenticar(
  sql: Sql,
  email: string,
  password: string,
): Promise<IdentidadAutenticada | null> {
  const cred = await buscarCredencialesPorEmail(sql, email);
  if (!cred) {
    // Igualamos el coste temporal: verificamos contra el señuelo y descartamos.
    await verifyPassword(await hashSenuelo(), password);
    return null;
  }
  const ok = await verifyPassword(cred.password_hash, password);
  if (!ok) return null;
  return { id: cred.id, rol: cred.rol };
}
