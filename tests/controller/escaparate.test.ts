import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import {
  crearAlumno,
  actualizarFicha,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
} from '../../src/model/student.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t24c-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

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
function get(app: ReturnType<typeof crearApp>, path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { headers });
}

describe('controller/escaparate — GET /api/escaparate/ediciones (solo SOCIO verificado)', () => {
  it.runIf(hasDb)('permisos: 401 sin sesión, 403 ALUMNO/ADMIN; SOCIO ve las cards visibles', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'EscCtrl', anio: 2026 }, null);

    // Alumno visible (activo + consentido) con un campo privado.
    const alumno = await crearAlumno(
      sql,
      { email: emailUnico('al'), password: PASSWORD, nombre: 'Katherine', edition_id: ed.id },
      null,
    );
    // Alumno no consultable (activo, sin consentir).
    const oculto = await crearAlumno(
      sql,
      { email: emailUnico('oc'), password: PASSWORD, nombre: 'Oculto', edition_id: ed.id },
      null,
    );
    const socio = await usuarioVerificado(sql, 'SOCIO');
    const admin = await usuarioVerificado(sql, 'ADMIN');
    try {
      await actualizarFicha(sql, alumno.usuario.id, { linkedin: 'https://linkedin/kj', privacy: { linkedin: false } }, null);
      await cambiarEstadoPorUserId(sql, alumno.usuario.id, 'activo', null);
      await registrarConsentimiento(sql, alumno.usuario.id, null);
      await cambiarEstadoPorUserId(sql, oculto.usuario.id, 'activo', null);

      // Cookie de sesión del propio alumno (rol ALUMNO) para el 403.
      const vt = await crearTokenVerificacion(sql, alumno.usuario.id);
      await verificarEmail(sql, vt.token);
      const sesionAlumno = await crearSesion(sql, alumno.usuario.id);
      const cookieAlumno = `sesion=${sesionAlumno.token}`;

      // Permisos.
      expect((await get(app, '/api/escaparate/ediciones')).status).toBe(401);
      expect((await get(app, '/api/escaparate/ediciones', cookieAlumno)).status).toBe(403);
      expect((await get(app, '/api/escaparate/ediciones', admin.cookie)).status).toBe(403);

      // SOCIO verificado: 200 con la edición y solo la card visible.
      const res = await get(app, '/api/escaparate/ediciones', socio.cookie);
      expect(res.status).toBe(200);
      const cuerpo = (await res.json()) as { id: string; alumnos: Record<string, unknown>[] }[];
      const nuestra = cuerpo.find((e) => e.id === ed.id)!;
      expect(nuestra.alumnos.map((a) => a.nombre)).toEqual(['Katherine']);
      const card = nuestra.alumnos[0];
      // Campo privado ausente; identidad presente; sin email ni privacy.
      expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(card, 'email')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);

      // GET /:id → 200 con la edición; inexistente → 404.
      const resId = await get(app, `/api/escaparate/ediciones/${ed.id}`, socio.cookie);
      expect(resId.status).toBe(200);
      expect(((await resId.json()) as { alumnos: unknown[] }).alumnos.length).toBe(1);
      expect((await get(app, '/api/escaparate/ediciones/00000000-0000-0000-0000-000000000000', socio.cookie)).status).toBe(404);
    } finally {
      await borrarUsuario(sql, alumno.usuario.id);
      await borrarUsuario(sql, oculto.usuario.id);
      await borrarUsuario(sql, socio.id);
      await borrarUsuario(sql, admin.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
