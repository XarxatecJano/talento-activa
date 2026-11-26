/**
 * Helpers de la cookie de sesión. Invariantes (CLAUDE.md):
 * nombre `sesion`; `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` solo en
 * producción; caducidad con `Expires` absoluto (NO `Max-Age`). El token viaja
 * únicamente en la cookie.
 */

export const NOMBRE_COOKIE = 'sesion';

/** ¿Estamos en producción? Determina el flag `Secure`. */
export function esProduccion(): boolean {
  return process.env.NODE_ENV === 'production';
}

function flagsComunes(secure: boolean): string[] {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  return flags;
}

/**
 * Construye el valor de la cabecera `Set-Cookie` para establecer la sesión.
 * @param secure Añade el flag `Secure` (por defecto, según el entorno).
 */
export function construirCookieSesion(
  token: string,
  expiresAt: Date,
  secure: boolean = esProduccion(),
): string {
  return [
    `${NOMBRE_COOKIE}=${token}`,
    ...flagsComunes(secure),
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');
}

/**
 * Construye el `Set-Cookie` que borra la sesión (valor vacío, caducada en el
 * epoch). Idempotente en el cliente.
 */
export function construirCookieBorrado(secure: boolean = esProduccion()): string {
  return [
    `${NOMBRE_COOKIE}=`,
    ...flagsComunes(secure),
    `Expires=${new Date(0).toUTCString()}`,
  ].join('; ');
}

/**
 * Lee el token de sesión de la cabecera `Cookie`.
 * @returns el token, o `null` si no está presente o está vacío.
 */
export function leerTokenCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const parte of cookieHeader.split(';')) {
    const trozo = parte.trim();
    const sep = trozo.indexOf('=');
    if (sep === -1) continue;
    if (trozo.slice(0, sep) === NOMBRE_COOKIE) {
      const valor = trozo.slice(sep + 1);
      return valor.length > 0 ? valor : null;
    }
  }
  return null;
}
