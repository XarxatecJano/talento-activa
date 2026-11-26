import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { autenticar } from './auth.js';
import { crearSesion, eliminarSesionPorToken } from '../model/session.js';
import { obtenerUsuarioPublico, crearUsuario, esRol } from '../model/user.js';
import { crearTokenVerificacion, verificarEmail } from '../model/email_verification.js';
import { crearEdicion, listarEdiciones, obtenerEdicion, cerrarEdicion } from '../model/edition.js';
import {
  crearAlumno,
  obtenerFichaPorUserId,
  actualizarFicha,
  cambiarEstadoPorUserId,
  cambiarEstadoAlumno,
  obtenerAlumnoPublico,
  obtenerAlumnoPublicoConContacto,
  borrarAlumnoPorUserId,
  borrarAlumnoPorId,
  registrarConsentimiento,
} from '../model/student.js';
import type { CambiosFicha, EstadoStudent } from '../model/student.js';
import { crearEmpresa, listarEmpresas, obtenerEmpresa, marcarSocia } from '../model/company.js';
import {
  listarEscaparate,
  obtenerEdicionEscaparate,
  listarProyectosEscaparate,
  listarAlumnosEscaparate,
} from '../model/escaparate.js';
import type { FiltrosAlumno } from '../model/escaparate.js';
import {
  crearProyecto,
  listarProyectosPorUserId,
  actualizarProyecto,
  borrarProyecto,
} from '../model/project.js';
import type { CambiosProyecto } from '../model/project.js';
import {
  SKILL_CFG,
  LANGUAGE_CFG,
  crearItemCatalogo,
  listarCatalogo,
  asociarAlumno,
  desasociarAlumno,
  listarAsociacionesAlumno,
  type CatalogoConfig,
} from '../model/catalog.js';
import { DatosInvalidosError, EmailYaRegistradoError, RecursoDuplicadoError } from '../model/errors.js';
import { construirCookieSesion, construirCookieBorrado, leerTokenCookie } from './cookie.js';
import { requiereAuth, requiereRol, requiereEmailVerificado, type AppEnv } from './middleware.js';

/**
 * Valida el body de edición de ficha y devuelve los cambios admitidos, o `null`
 * si algún campo presente es inválido o no hay ningún campo editable.
 */
function parsearCambiosFicha(body: unknown): CambiosFicha | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const cambios: CambiosFicha = {};
  const esStrONull = (v: unknown) => v === null || typeof v === 'string';

  if ('nombre' in b) {
    if (typeof b.nombre !== 'string' || b.nombre.trim() === '') return null;
    cambios.nombre = b.nombre;
  }
  for (const k of ['foto_url', 'bio', 'ubicacion', 'cv_url', 'linkedin', 'github'] as const) {
    if (k in b) {
      if (!esStrONull(b[k])) return null;
      cambios[k] = b[k] as string | null;
    }
  }
  if ('disponibilidad_traslado' in b) {
    if (typeof b.disponibilidad_traslado !== 'boolean') return null;
    cambios.disponibilidad_traslado = b.disponibilidad_traslado;
  }
  if ('modalidad' in b) {
    if (b.modalidad !== null && !['remoto', 'presencial', 'hibrido'].includes(b.modalidad as string)) return null;
    cambios.modalidad = b.modalidad as CambiosFicha['modalidad'];
  }
  if ('estado_laboral' in b) {
    if (b.estado_laboral !== null && !['buscando', 'trabajando'].includes(b.estado_laboral as string)) return null;
    cambios.estado_laboral = b.estado_laboral as CambiosFicha['estado_laboral'];
  }
  if ('privacy' in b) {
    if (typeof b.privacy !== 'object' || b.privacy === null || Array.isArray(b.privacy)) return null;
    cambios.privacy = b.privacy as Record<string, unknown>;
  }

  return Object.keys(cambios).length > 0 ? cambios : null;
}

/**
 * Valida los parámetros de búsqueda del escaparate de alumnos (T26) y devuelve
 * los filtros admitidos, o `null` si algún parámetro presente tiene un valor no
 * válido. Todos los filtros son opcionales y combinables; sin parámetros devuelve
 * `{}` (listar todos los visibles).
 */
function parsearFiltrosAlumno(q: Record<string, string>): FiltrosAlumno | null {
  const filtros: FiltrosAlumno = {};

  const noVacio = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';
  if (noVacio(q.skill)) filtros.skill = q.skill;
  else if ('skill' in q) return null;
  if (noVacio(q.edicion)) filtros.edicion = q.edicion;
  else if ('edicion' in q) return null;

  if ('modalidad' in q) {
    if (!['remoto', 'presencial', 'hibrido'].includes(q.modalidad)) return null;
    filtros.modalidad = q.modalidad as FiltrosAlumno['modalidad'];
  }
  if ('estado_laboral' in q) {
    if (!['buscando', 'trabajando'].includes(q.estado_laboral)) return null;
    filtros.estado_laboral = q.estado_laboral as FiltrosAlumno['estado_laboral'];
  }
  if ('disponibilidad' in q) {
    if (q.disponibilidad !== 'true' && q.disponibilidad !== 'false') return null;
    filtros.disponibilidad = q.disponibilidad === 'true';
  }

  return filtros;
}

/** Valida el body de edición de proyecto; `null` si inválido o sin campos. */
function parsearCambiosProyecto(body: unknown): CambiosProyecto | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const cambios: CambiosProyecto = {};
  if ('titulo' in b) {
    if (typeof b.titulo !== 'string') return null;
    cambios.titulo = b.titulo;
  }
  if ('url' in b) {
    if (typeof b.url !== 'string') return null;
    cambios.url = b.url;
  }
  for (const k of ['descripcion', 'thumbnail_url'] as const) {
    if (k in b) {
      if (b[k] !== null && typeof b[k] !== 'string') return null;
      cambios[k] = b[k] as string | null;
    }
  }
  return Object.keys(cambios).length > 0 ? cambios : null;
}
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

  // GET /api/health — señal de vida (sin autenticación).
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

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

  // --- Ediciones (administración, solo ADMIN) ---------------------------------

  app.post('/api/ediciones', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as
      | { nombre?: unknown; anio?: unknown; fecha_inicio?: unknown; fecha_fin?: unknown }
      | null;
    if (!body || typeof body.nombre !== 'string' || typeof body.anio !== 'number') {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    try {
      const ed = await crearEdicion(
        sql,
        {
          nombre: body.nombre,
          anio: body.anio,
          fecha_inicio: typeof body.fecha_inicio === 'string' ? body.fecha_inicio : null,
          fecha_fin: typeof body.fecha_fin === 'string' ? body.fecha_fin : null,
        },
        actor.id,
      );
      return c.json(ed, 201);
    } catch (err) {
      if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get('/api/ediciones', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    return c.json(await listarEdiciones(sql));
  });

  app.get('/api/ediciones/:id', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const ed = await obtenerEdicion(sql, c.req.param('id'));
    if (!ed) return c.json({ error: 'No encontrada' }, 404);
    return c.json(ed);
  });

  app.post('/api/ediciones/:id/cerrar', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const ed = await cerrarEdicion(sql, c.req.param('id'), actor.id);
    if (!ed) return c.json({ error: 'No encontrada' }, 404);
    return c.json(ed);
  });

  // --- Alumnos (alta por admin; alumno finalizado) ----------------------------

  app.post('/api/alumnos', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as
      | { email?: unknown; password?: unknown; nombre?: unknown; edition_id?: unknown }
      | null;
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string' ||
      typeof body.nombre !== 'string' ||
      typeof body.edition_id !== 'string'
    ) {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    try {
      const { usuario, student } = await crearAlumno(
        sql,
        { email: body.email, password: body.password, nombre: body.nombre, edition_id: body.edition_id },
        actor.id,
      );
      // Envía la verificación al alumno (best-effort).
      try {
        const { token } = await crearTokenVerificacion(sql, usuario.id);
        await enviador.enviarVerificacion(usuario.email, token);
      } catch {
        /* el fallo de envío no invalida el alta */
      }
      return c.json({ student, usuario }, 201);
    } catch (err) {
      if (err instanceof EmailYaRegistradoError) return c.json({ error: err.message }, 409);
      if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // --- Ficha propia del alumno ------------------------------------------------

  app.get(
    '/api/alumnos/me',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const ficha = await obtenerFichaPorUserId(sql, actor.id);
      if (!ficha) return c.json({ error: 'Ficha no encontrada' }, 404);
      return c.json(ficha);
    },
  );

  app.patch(
    '/api/alumnos/me',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const cambios = parsearCambiosFicha(await c.req.json().catch(() => null));
      if (!cambios) return c.json({ error: 'Datos no válidos' }, 400);
      const ficha = await actualizarFicha(sql, actor.id, cambios, actor.id);
      if (!ficha) return c.json({ error: 'Ficha no encontrada' }, 404);
      return c.json(ficha);
    },
  );

  // Consentimiento explícito del alumno para publicar sus datos (RGPD).
  app.post(
    '/api/alumnos/me/consentimiento',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const ficha = await registrarConsentimiento(sql, actor.id, actor.id);
      if (!ficha) return c.json({ error: 'Ficha no encontrada' }, 404);
      return c.json(ficha);
    },
  );

  // Alumno cambia su propio estado.
  app.patch(
    '/api/alumnos/me/estado',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const body = (await c.req.json().catch(() => null)) as { estado?: unknown } | null;
      if (!body || (body.estado !== 'activo' && body.estado !== 'inactivo')) {
        return c.json({ error: 'Datos no válidos' }, 400);
      }
      const student = await cambiarEstadoPorUserId(sql, actor.id, body.estado as EstadoStudent, actor.id);
      if (!student) return c.json({ error: 'Ficha no encontrada' }, 404);
      return c.json(student);
    },
  );

  // Admin cambia el estado de cualquier alumno.
  app.patch('/api/alumnos/:id/estado', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as { estado?: unknown } | null;
    if (!body || (body.estado !== 'activo' && body.estado !== 'inactivo')) {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    const student = await cambiarEstadoAlumno(sql, c.req.param('id'), body.estado as EstadoStudent, actor.id);
    if (!student) return c.json({ error: 'No encontrado' }, 404);
    return c.json(student);
  });

  // --- Proyectos del alumno (propios) -----------------------------------------

  app.post(
    '/api/alumnos/me/proyectos',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const body = (await c.req.json().catch(() => null)) as
        | { titulo?: unknown; url?: unknown; descripcion?: unknown; thumbnail_url?: unknown }
        | null;
      if (!body || typeof body.titulo !== 'string' || typeof body.url !== 'string') {
        return c.json({ error: 'Datos no válidos' }, 400);
      }
      try {
        const proyecto = await crearProyecto(
          sql,
          actor.id,
          {
            titulo: body.titulo,
            url: body.url,
            descripcion: typeof body.descripcion === 'string' ? body.descripcion : null,
            thumbnail_url: typeof body.thumbnail_url === 'string' ? body.thumbnail_url : null,
          },
          actor.id,
        );
        if (!proyecto) return c.json({ error: 'Ficha no encontrada' }, 404);
        return c.json(proyecto, 201);
      } catch (err) {
        if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
        throw err;
      }
    },
  );

  app.get(
    '/api/alumnos/me/proyectos',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      return c.json(await listarProyectosPorUserId(sql, actor.id));
    },
  );

  app.patch(
    '/api/alumnos/me/proyectos/:id',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const cambios: CambiosProyecto | null = parsearCambiosProyecto(await c.req.json().catch(() => null));
      if (!cambios) return c.json({ error: 'Datos no válidos' }, 400);
      try {
        const proyecto = await actualizarProyecto(sql, actor.id, c.req.param('id'), cambios, actor.id);
        if (!proyecto) return c.json({ error: 'No encontrado' }, 404);
        return c.json(proyecto);
      } catch (err) {
        if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
        throw err;
      }
    },
  );

  app.delete(
    '/api/alumnos/me/proyectos/:id',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const borrado = await borrarProyecto(sql, actor.id, c.req.param('id'), actor.id);
      if (!borrado) return c.json({ error: 'No encontrado' }, 404);
      return c.body(null, 204);
    },
  );

  // Derecho al olvido: el alumno borra su cuenta y todos sus datos (cascada).
  app.delete(
    '/api/alumnos/me',
    requiereAuth(sql),
    requiereRol('ALUMNO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const actor = c.get('actor');
      const borrado = await borrarAlumnoPorUserId(sql, actor.id, actor.id);
      if (!borrado) return c.json({ error: 'Ficha no encontrada' }, 404);
      return c.body(null, 204);
    },
  );

  // Admin ejerce el borrado de un alumno (derecho al olvido).
  app.delete('/api/alumnos/:id', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const borrado = await borrarAlumnoPorId(sql, c.req.param('id'), actor.id);
    if (!borrado) return c.json({ error: 'No encontrado' }, 404);
    return c.body(null, 204);
  });

  // Empresa consulta un alumno (solo activos; enforcement de visibilidad).
  app.get(
    '/api/alumnos/:id',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const alumno = await obtenerAlumnoPublico(sql, c.req.param('id'));
      if (!alumno) return c.json({ error: 'No encontrado' }, 404);
      return c.json(alumno);
    },
  );

  // --- Escaparate (lectura; solo SOCIO verificado) ----------------------------
  // Cards de alumnos consultables (activos + consentidos) agrupadas por edición,
  // con la privacidad por campo aplicada. No público: tras auth + rol SOCIO +
  // email verificado.

  app.get(
    '/api/escaparate/ediciones',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => c.json(await listarEscaparate(sql)),
  );

  app.get(
    '/api/escaparate/ediciones/:id',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const ed = await obtenerEdicionEscaparate(sql, c.req.param('id'));
      if (!ed) return c.json({ error: 'No encontrada' }, 404);
      return c.json(ed);
    },
  );

  app.get(
    '/api/escaparate/proyectos',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => c.json(await listarProyectosEscaparate(sql)),
  );

  // Búsqueda y filtrado estructurado de alumnos (T26): filtros combinables
  // (skill, edicion, modalidad, disponibilidad, estado_laboral), solo sobre
  // visibles (activos + consentidos) y con la privacidad por campo aplicada.
  app.get(
    '/api/escaparate/alumnos',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const filtros = parsearFiltrosAlumno(c.req.query());
      if (!filtros) return c.json({ error: 'Datos no válidos' }, 400);
      return c.json(await listarAlumnosEscaparate(sql, filtros));
    },
  );

  // Ficha completa de un alumno para la empresa (T27): proyección pública con la
  // privacidad por campo aplicada e, incluyendo el email de contacto cuando el
  // alumno consintió y no lo marcó privado ("contacto por revelación"). Un alumno
  // no consultable (inactivo o sin consentir) o inexistente → 404.
  app.get(
    '/api/escaparate/alumnos/:id',
    requiereAuth(sql),
    requiereRol('SOCIO'),
    requiereEmailVerificado(sql),
    async (c) => {
      const alumno = await obtenerAlumnoPublicoConContacto(sql, c.req.param('id'));
      if (!alumno) return c.json({ error: 'No encontrado' }, 404);
      return c.json(alumno);
    },
  );

  // --- Empresas (alta por invitación; marcado de socia) -----------------------

  app.post('/api/empresas', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as
      | { nombre?: unknown; email?: unknown; password?: unknown; contacto?: unknown; es_socia?: unknown }
      | null;
    if (
      !body ||
      typeof body.nombre !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string'
    ) {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    try {
      const { usuario, company } = await crearEmpresa(
        sql,
        {
          nombre: body.nombre,
          email: body.email,
          password: body.password,
          contacto: typeof body.contacto === 'string' ? body.contacto : null,
          es_socia: typeof body.es_socia === 'boolean' ? body.es_socia : false,
        },
        actor.id,
      );
      try {
        const { token } = await crearTokenVerificacion(sql, usuario.id);
        await enviador.enviarVerificacion(usuario.email, token);
      } catch {
        /* el fallo de envío no invalida el alta */
      }
      return c.json({ company, usuario }, 201);
    } catch (err) {
      if (err instanceof EmailYaRegistradoError) return c.json({ error: err.message }, 409);
      if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get('/api/empresas', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    return c.json(await listarEmpresas(sql));
  });

  app.get('/api/empresas/:id', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const empresa = await obtenerEmpresa(sql, c.req.param('id'));
    if (!empresa) return c.json({ error: 'No encontrada' }, 404);
    return c.json(empresa);
  });

  app.patch('/api/empresas/:id', requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
    const actor = c.get('actor');
    const body = (await c.req.json().catch(() => null)) as { es_socia?: unknown } | null;
    if (!body || typeof body.es_socia !== 'boolean') {
      return c.json({ error: 'Datos no válidos' }, 400);
    }
    const empresa = await marcarSocia(sql, c.req.param('id'), body.es_socia, actor.id);
    if (!empresa) return c.json({ error: 'No encontrada' }, 404);
    return c.json(empresa);
  });

  // --- Catálogos (skills, idiomas) + asociación N:M con nivel ------------------

  const registrarCatalogo = (basePath: string, cfg: CatalogoConfig) => {
    // Catálogo: crear (ADMIN) y listar (cualquier autenticado).
    app.post(`/api/${basePath}`, requiereAuth(sql), requiereRol('ADMIN'), async (c) => {
      const actor = c.get('actor');
      const body = (await c.req.json().catch(() => null)) as { nombre?: unknown } | null;
      if (!body || typeof body.nombre !== 'string') return c.json({ error: 'Datos no válidos' }, 400);
      try {
        const item = await crearItemCatalogo(sql, cfg, body.nombre, actor.id);
        return c.json(item, 201);
      } catch (err) {
        if (err instanceof RecursoDuplicadoError) return c.json({ error: err.message }, 409);
        if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
        throw err;
      }
    });

    app.get(`/api/${basePath}`, requiereAuth(sql), async (c) => c.json(await listarCatalogo(sql, cfg)));

    // Asociación del alumno con su nivel.
    app.get(
      `/api/alumnos/me/${basePath}`,
      requiereAuth(sql),
      requiereRol('ALUMNO'),
      requiereEmailVerificado(sql),
      async (c) => c.json(await listarAsociacionesAlumno(sql, cfg, c.get('actor').id)),
    );

    app.put(
      `/api/alumnos/me/${basePath}/:id`,
      requiereAuth(sql),
      requiereRol('ALUMNO'),
      requiereEmailVerificado(sql),
      async (c) => {
        const actor = c.get('actor');
        const body = (await c.req.json().catch(() => null)) as { nivel?: unknown } | null;
        if (!body || typeof body.nivel !== 'string') return c.json({ error: 'Datos no válidos' }, 400);
        try {
          const r = await asociarAlumno(sql, cfg, actor.id, c.req.param('id'), body.nivel, actor.id);
          if (r !== 'ok') return c.json({ error: 'No encontrado' }, 404);
          return c.json({ ok: true });
        } catch (err) {
          if (err instanceof DatosInvalidosError) return c.json({ error: err.message }, 400);
          throw err;
        }
      },
    );

    app.delete(
      `/api/alumnos/me/${basePath}/:id`,
      requiereAuth(sql),
      requiereRol('ALUMNO'),
      requiereEmailVerificado(sql),
      async (c) => {
        const ok = await desasociarAlumno(sql, cfg, c.get('actor').id, c.req.param('id'), c.get('actor').id);
        if (!ok) return c.json({ error: 'No encontrado' }, 404);
        return c.body(null, 204);
      },
    );
  };

  registrarCatalogo('skills', SKILL_CFG);
  registrarCatalogo('idiomas', LANGUAGE_CFG);

  return app;
}
