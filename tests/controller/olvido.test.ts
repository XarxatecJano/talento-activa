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
const emailUnico = (p: string) => `t17-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "User" where id = ${userId}`;
}
async function limpiarAudit(sql: ReturnType<typeof createDb>, ...ids: string[]) {
  for (const id of ids) await sql`delete from "Audit_log" where id_registro = ${id}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function usuarioVerificado(sql: ReturnType<typeof createDb>, rol: 'ADMIN' | 'ALUMNO') {
  const u = await crearUsuario(sql, { email: emailUnico(rol.toLowerCase()), password: PASSWORD, rol });
  const vt = await crearTokenVerificacion(sql, u.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, u.id);
  return { id: u.id, cookie: `sesion=${token}` };
}
async function alumnoConDatos(sql: ReturnType<typeof createDb>) {
  const ed = await crearEdicion(sql, { nombre: 'OlvidoEd', anio: 2026 }, null);
  const { usuario, student } = await crearAlumno(sql, { email: emailUnico('al'), password: PASSWORD, nombre: 'Olvidado', edition_id: ed.id }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  // Datos relacionados que deben desaparecer en cascada.
  await sql`insert into "Project" (student_id, titulo, url) values (${student.id}, 'Proyecto', 'https://ejemplo.test/p')`;
  await sql`insert into "Reminder_state" (student_id) values (${student.id})`;
  return { edId: ed.id, userId: usuario.id, studentId: student.id, cookie: `sesion=${token}` };
}
function del(app: ReturnType<typeof crearApp>, path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method: 'DELETE', headers });
}

describe('controller/olvido — derecho al olvido (borrado en cascada)', () => {
  it.runIf(hasDb)('el alumno se borra a sí mismo: User+Student y datos relacionados desaparecen; se audita', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie } = await alumnoConDatos(sql);
    try {
      const res = await del(app, '/api/alumnos/me', cookie);
      expect(res.status).toBe(204);

      expect(await sql`select 1 from "User" where id = ${userId}`).toHaveLength(0);
      expect(await sql`select 1 from "Student" where id = ${studentId}`).toHaveLength(0);
      expect(await sql`select 1 from "Project" where student_id = ${studentId}`).toHaveLength(0);
      expect(await sql`select 1 from "Reminder_state" where student_id = ${studentId}`).toHaveLength(0);

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Student' and id_registro = ${studentId} and operacion = 'DELETE'`;
      expect(audit).toHaveLength(1);
    } finally {
      await limpiarAudit(sql, userId, studentId, edId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('un admin borra un alumno; no-admin → 403; id inexistente → 404', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId } = await alumnoConDatos(sql);
    const admin = await usuarioVerificado(sql, 'ADMIN');
    const otro = await usuarioVerificado(sql, 'ALUMNO');
    try {
      // no-admin
      expect((await del(app, `/api/alumnos/${studentId}`, otro.cookie)).status).toBe(403);
      // id inexistente
      expect((await del(app, '/api/alumnos/00000000-0000-0000-0000-000000000000', admin.cookie)).status).toBe(404);
      // admin borra
      const res = await del(app, `/api/alumnos/${studentId}`, admin.cookie);
      expect(res.status).toBe(204);
      expect(await sql`select 1 from "User" where id = ${userId}`).toHaveLength(0);
    } finally {
      await limpiarAudit(sql, userId, studentId, edId);
      await borrarUsuario(sql, admin.id);
      await borrarUsuario(sql, otro.id);
      await limpiarAudit(sql, admin.id, otro.id);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});
