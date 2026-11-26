import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { autenticar } from './auth.js';
import { crearSesion, eliminarSesionPorToken } from '../model/session.js';
import { obtenerUsuarioPublico, crearUsuario, esRol } from '../model/user.js';
import { crearTokenVerificacion, verificarEmail } from '../model/email_verification.js';
import { DatosInvalidosError, EmailYaRegistradoError } from '../model/errors.js';
import { construirCookieSesion, construirCookieBorrado, leerTokenCookie } from './cookie.js';
import { requiereAuth, requiereRol, type AppEnv } from './middleware.js';
import { enviadorNoop, type EnviadorEmail } from './email.js';

export interface OpcionesApp {
  /** Enviador de email transaccional. Por defecto, un no-op. */
  enviador?: EnviadorEmail;
}

/**
 * Construye la app Hono con las rutas de la API. Recibe el cliente `sql` por
 * inyección para poder testear con una BD real sin depender de un singleton.
 */
export function crearApp(sql: Sql, opciones: OpcionesApp = {}): Hono<AppEnv> {
  const enviador = opciones.enviador ?? enviadorNoop;
  const app = new Hono<AppEnv>();

  // POST /api/auth/login — crea una sesión nueva (invalidando la previa de la
  // cookie) si las credenciales son válidas. Anti-enumeración en `autenticar`.
  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { email?: unknown; password?: unknown }
      | null;

    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      return c.json({ error: 'Datos no válidos' }, 400);
    }

    const identidad = await autenticar(sql, body.email, body.password);
    if (!identidad) {
      return c.json({ error: 'Credenciales no válidas' }, 401);
    }

    // Invalida la sesión previa que viniera en la cookie.
    const tokenPrevio = leerTokenCookie(c.req.header('Cookie'));
    if (tokenPrevio) await eliminarSesionPorToken(sql, tokenPrevio);

    // Crea la sesión nueva y repone la cookie. El token viaja SOLO en la cookie.
    const { token, expiresAt } = await crearSesion(sql, identidad.id);
    c.header('Set-Cookie', construirCookieSesion(token, expiresAt));

    return c.json({ id: identidad.id, rol: identidad.rol }, 200);
  });

  // POST /api/auth/register — alta por invitación, restringida a ADMIN. No hay
  // registro público. La cuenta nace con email_verified=false.
  app.post('/api/auth/register', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as
      | { email?: unknown; password?: unknown; rol?: unknown }
      | null;

    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string' || !esRol(body.rol)) {
      return c.json({ error: 'Datos no válidos' }, 400);
    }

    try {
      const usuario = await crearUsuario(
        sql,
        { email: body.email, password: body.password, rol: body.rol },
        actor.id,
      );
      // Envía la verificación (best-effort: la cuenta ya existe aunque el email
      // falle; en el futuro habrá reenvío). La cuenta nace sin verificar.
      try {
        const { token } = await crearTokenVerificacion(sql, usuario.id);
        await enviador.enviarVerificacion(usuario.email, token);
      } catch {
        /* el fallo de envío no invalida el alta */
      }
      return c.json(usuario, 201);
    } catch (err) {
      if (err instanceof EmailYaRegistradoError) return c.json({ error: err.message }, 409);
      if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // POST /api/auth/verify — consume el token de verificación de email. Público
  // (el usuario llega desde el enlace del email). De un solo uso.
  app.post('/api/auth/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    if (!body || typeof body.token !== 'string') {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    const ok = await verificarEmail(sql, body.token);
    if (!ok) return c.json({ error: 'Token no válido o caducado' }, 400);
    return c.json({ ok: true }, 200);
  });

  // POST /api/auth/logout — borra la sesión y limpia la cookie. Idempotente.
  app.post('/api/auth/logout', async (c) => {
    const token = leerTokenCookie(c.req.header('Cookie'));
    if (token) await eliminarSesionPorToken(sql, token);
    c.header('Set-Cookie', construirCookieBorrado());
    return c.body(null, 204);
  });

  // GET /api/me — usuario actual (proyección pública sin hash). El middleware
  // resuelve la sesión (401 si no hay) y repone la cookie si hubo renovación.
  app.get('/api/me', requiereAuth(sql), async (c) => {
    const actor = c.get('actor');
    const usuario = await obtenerUsuarioPublico(sql, actor.id);
    if (!usuario) return c.json({ error: 'No autenticado' }, 401);
    return c.json(usuario, 200);
  });

  return app;
}
