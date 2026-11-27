import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './middleware.js';

/** UUID textual (cualquier versión): 8-4-4-4-12 hex, insensible a mayúsculas. */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `true` si `v` es un UUID bien formado. Se usa en el controlador para rechazar
 * identificadores (de ruta, query o body) que acabarían comparándose con una
 * columna `uuid` de Postgres: un valor no-UUID provocaría un error `22P02`
 * (*invalid input syntax for type uuid*) y un 500 espurio si llegara a la
 * consulta, de modo que se traduce antes a 404/400 según el caso.
 */
export function esUuid(v: unknown): v is string {
  return typeof v === 'string' && RE_UUID.test(v);
}

/**
 * Middleware que exige que un parámetro de ruta sea un UUID. Si no lo es,
 * responde 404 (el recurso no puede existir) sin tocar el modelo. Se coloca al
 * final de la cadena de middlewares de una ruta `:id`, tras la autenticación y
 * autorización (de modo que un no-autenticado siga recibiendo 401/403 primero).
 */
export function uuidParam(nombre = 'id'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!esUuid(c.req.param(nombre))) {
      return c.json({ error: 'No encontrado' }, 404);
    }
    await next();
  };
}
