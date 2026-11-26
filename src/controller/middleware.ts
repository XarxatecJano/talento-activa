import type { MiddlewareHandler } from 'hono';
import type { Sql } from 'postgres';
import { resolverSesion } from '../model/session.js';
import type { Actor } from '../model/session.js';
import type { Rol } from '../model/user.js';
import { estaEmailVerificado } from '../model/user.js';
import { construirCookieSesion, leerTokenCookie } from './cookie.js';

/** Variables de contexto compartidas por la app autenticada. */
export type AppEnv = { Variables: { actor: Actor } };

/**
 * Middleware de autenticación: resuelve la sesión de la cookie, exige que sea
 * válida (401 si no) y deja el `Actor {id, rol}` en el contexto (`c.get('actor')`).
 * Si hubo renovación deslizante, repone la cookie.
 */
export function requiereAuth(sql: Sql): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = leerTokenCookie(c.req.header('Cookie'));
    if (!token) return c.json({ error: 'No autenticado' }, 401);

    const resuelta = await resolverSesion(sql, token);
    if (!resuelta) return c.json({ error: 'No autenticado' }, 401);

    if (resuelta.renovada) {
      c.header('Set-Cookie', construirCookieSesion(token, resuelta.expiresAt));
    }
    c.set('actor', resuelta.actor);
    await next();
  };
}

/**
 * Middleware de autorización por rol. Debe ir DESPUÉS de `requiereAuth`. Responde
 * 403 si el rol del actor no está entre los permitidos.
 */
export function requiereRol(...roles: Rol[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (!actor || !roles.includes(actor.rol)) {
      return c.json({ error: 'No autorizado' }, 403);
    }
    await next();
  };
}

/**
 * Middleware que exige que el usuario tenga el email verificado (403 si no).
 * Debe ir DESPUÉS de `requiereAuth`. Se aplica a las rutas de acceso real (no a
 * login/logout/me), para bloquear el acceso a recursos hasta verificar.
 */
export function requiereEmailVerificado(sql: Sql): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (!actor || !(await estaEmailVerificado(sql, actor.id))) {
      return c.json({ error: 'Email no verificado' }, 403);
    }
    await next();
  };
}
