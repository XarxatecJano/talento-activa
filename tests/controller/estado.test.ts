import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearAlumno } from '../../src/model/student.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t16-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function usuarioVerificado(sql: ReturnType<typeof createDb>, rol: 'ADMIN' | 'SOCIO') {
  const u = await crearUsuario(sql, { email: emailUnico(rol.toLowerCase()), password: PASSWORD, rol });
  const vt = await crearTokenVerificacion(sql, u.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, u.id);
  return { id: u.id, cookie: `sesion=${token}` };
}
async function alumnoListo(sql: ReturnType<typeof createDb>) {
  const ed = await crearEdicion(sql, { nombre: 'EstEd', anio: 2026 }, null);
  const { usuario, student } = await crearAlumno(sql, { email: emailUnico('al'), password: PASSWORD, nombre: 'Linus', edition_id: ed.id }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { edId: ed.id, userId: usuario.id, studentId: student.id, cookie: `sesion=${token}` };
}
function patch(app: ReturnType<typeof crearApp>, path: string, cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method: 'PATCH', headers, body: JSON.stringify(body) });
}
function get(app: ReturnType<typeof crearApp>, path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { headers });
}

describe('controller/estado — cambio de estado del alumno', () => {
  it.runIf(hasDb)('el alumno cambia su propio estado (y audita); estado inválido → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie } = await alumnoListo(sql);
    try {
      const res = await patch(app, '/api/alumnos/me/estado', cookie, { estado: 'activo' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { estado: string }).estado).toBe('activo');

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Student' and id_registro = ${studentId} and operacion = 'UPDATE'`;
      expect(audit.length).toBeGreaterThanOrEqual(1);

      expect((await patch(app, '/api/alumnos/me/estado', cookie, { estado: 'borrado' })).status).toBe(400);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('un admin cambia el estado de un alumno; no-admin → 403; id inexistente → 404', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie: cookieAlumno } = await alumnoListo(sql);
    const admin = await usuarioVerificado(sql, 'ADMIN');
    try {
      const res = await patch(app, `/api/alumnos/${studentId}/estado`, admin.cookie, { estado: 'activo' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { estado: string }).estado).toBe('activo');

      // Un alumno no puede usar la ruta de admin.
      expect((await patch(app, `/api/alumnos/${studentId}/estado`, cookieAlumno, { estado: 'inactivo' })).status).toBe(403);
      expect((await patch(app, '/api/alumnos/00000000-0000-0000-0000-000000000000/estado', admin.cookie, { estado: 'activo' })).status).toBe(404);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarUsuario(sql, admin.id);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});

describe('controller/estado — enforcement: inactivo no consultable por empresas', () => {
  it.runIf(hasDb)('SOCIO: 404 si inactivo, 200 (proyección pública sin email) si activo', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie: cookieAlumno } = await alumnoListo(sql);
    const socio = await usuarioVerificado(sql, 'SOCIO');
    try {
      // Nace inactivo → no consultable.
      expect((await get(app, `/api/alumnos/${studentId}`, socio.cookie)).status).toBe(404);

      // El alumno se activa.
      await patch(app, '/api/alumnos/me/estado', cookieAlumno, { estado: 'activo' });

      const res = await get(app, `/api/alumnos/${studentId}`, socio.cookie);
      expect(res.status).toBe(200);
      const pub = (await res.json()) as Record<string, unknown>;
      expect(pub).toMatchObject({ id: studentId, nombre: 'Linus' });
      expect(pub).not.toHaveProperty('email');
      expect(pub).not.toHaveProperty('privacy');

      // Permisos de la ruta de consulta.
      expect((await get(app, `/api/alumnos/${studentId}`)).status).toBe(401);
      expect((await get(app, `/api/alumnos/${studentId}`, cookieAlumno)).status).toBe(403); // ALUMNO no es empresa
    } finally {
      await borrarUsuario(sql, userId);
      await borrarUsuario(sql, socio.id);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});
