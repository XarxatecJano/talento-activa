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
const emailUnico = (p: string) => `t20-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function usuarioVerificado(sql: ReturnType<typeof createDb>, rol: 'SOCIO') {
  const u = await crearUsuario(sql, { email: emailUnico(rol.toLowerCase()), password: PASSWORD, rol });
  const vt = await crearTokenVerificacion(sql, u.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, u.id);
  return { id: u.id, cookie: `sesion=${token}` };
}
async function alumnoListo(sql: ReturnType<typeof createDb>) {
  const ed = await crearEdicion(sql, { nombre: 'ConsEd', anio: 2026 }, null);
  const { usuario, student } = await crearAlumno(sql, { email: emailUnico('al'), password: PASSWORD, nombre: 'Consentida', edition_id: ed.id }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { edId: ed.id, userId: usuario.id, studentId: student.id, cookie: `sesion=${token}` };
}

describe('controller/consentimiento — POST /api/alumnos/me/consentimiento', () => {
  it.runIf(hasDb)('registra el consentimiento (consent_at) y audita; 401/403 según rol', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie } = await alumnoListo(sql);
    try {
      expect((await app.request('/api/alumnos/me/consentimiento', { method: 'POST' })).status).toBe(401);

      const res = await app.request('/api/alumnos/me/consentimiento', { method: 'POST', headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const ficha = (await res.json()) as { consent_at: string | null };
      expect(ficha.consent_at).not.toBeNull();

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Student' and id_registro = ${studentId} and operacion = 'UPDATE'`;
      expect(audit.length).toBeGreaterThanOrEqual(1);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});

describe('controller/consentimiento — enforcement: sin consentimiento no es consultable', () => {
  it.runIf(hasDb)('alumno activo SIN consentimiento → SOCIO 404; tras consentir → 200', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie } = await alumnoListo(sql);
    const socio = await usuarioVerificado(sql, 'SOCIO');
    try {
      // Se activa pero aún no ha consentido → no publicable.
      await app.request('/api/alumnos/me/estado', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ estado: 'activo' }),
      });
      expect((await app.request(`/api/alumnos/${studentId}`, { headers: { Cookie: socio.cookie } })).status).toBe(404);

      // Consiente → ya es consultable.
      await app.request('/api/alumnos/me/consentimiento', { method: 'POST', headers: { Cookie: cookie } });
      expect((await app.request(`/api/alumnos/${studentId}`, { headers: { Cookie: socio.cookie } })).status).toBe(200);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarUsuario(sql, socio.id);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});
