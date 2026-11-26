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
import { crearProyecto } from '../../src/model/project.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t25c-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

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

describe('controller/escaparate — GET /api/escaparate/proyectos (solo SOCIO verificado)', () => {
  it.runIf(hasDb)('permisos: 401 sin sesión, 403 ALUMNO/ADMIN; SOCIO ve solo proyectos de alumnos visibles', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'ProyEscCtrl', anio: 2026 }, null);

    const alumno = await crearAlumno(
      sql,
      { email: emailUnico('al'), password: PASSWORD, nombre: 'Katherine', edition_id: ed.id },
      null,
    );
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
      await crearProyecto(sql, alumno.usuario.id, { titulo: 'ProyKat', url: 'https://github.com/k/p', thumbnail_url: 'https://cdn/k.png' }, null);

      // Alumno activo pero sin consentir → su proyecto no aparece.
      await cambiarEstadoPorUserId(sql, oculto.usuario.id, 'activo', null);
      await crearProyecto(sql, oculto.usuario.id, { titulo: 'ProyOculto', url: 'https://github.com/o/p' }, null);

      // Cookie de sesión del propio alumno (rol ALUMNO) para el 403.
      const vt = await crearTokenVerificacion(sql, alumno.usuario.id);
      await verificarEmail(sql, vt.token);
      const sesionAlumno = await crearSesion(sql, alumno.usuario.id);
      const cookieAlumno = `sesion=${sesionAlumno.token}`;

      // Permisos.
      expect((await get(app, '/api/escaparate/proyectos')).status).toBe(401);
      expect((await get(app, '/api/escaparate/proyectos', cookieAlumno)).status).toBe(403);
      expect((await get(app, '/api/escaparate/proyectos', admin.cookie)).status).toBe(403);

      // SOCIO verificado: 200 con solo el proyecto visible.
      const res = await get(app, '/api/escaparate/proyectos', socio.cookie);
      expect(res.status).toBe(200);
      const cuerpo = (await res.json()) as { titulo: string; thumbnail_url: string | null; alumno: Record<string, unknown> }[];
      const nuestros = cuerpo.filter((p) => (p.alumno as { edition_id?: string }).edition_id === ed.id);
      expect(nuestros.map((p) => p.titulo)).toEqual(['ProyKat']);
      const card = nuestros[0]!;
      expect(card.thumbnail_url).toBe('https://cdn/k.png');
      // Privacidad del dueño aplicada; sin email ni privacy en el autor.
      expect(Object.prototype.hasOwnProperty.call(card.alumno, 'linkedin')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(card.alumno, 'email')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(card.alumno, 'privacy')).toBe(false);
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
