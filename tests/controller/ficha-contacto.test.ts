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
const emailUnico = (p: string) => `t27c-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

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

describe('controller/escaparate — GET /api/escaparate/alumnos/:id (ficha + contacto, T27)', () => {
  it.runIf(hasDb)(
    'permisos y revelación de contacto según consentimiento y privacidad',
    async () => {
      const sql = createDb();
      const app = crearApp(sql);
      const ed = await crearEdicion(sql, { nombre: 'T27Ctrl', anio: 2026 }, null);

      const emailAlumno = emailUnico('al');
      const alumno = await crearAlumno(
        sql,
        { email: emailAlumno, password: PASSWORD, nombre: 'Katherine', edition_id: ed.id },
        null,
      );
      // No consultable: activo pero sin consentir.
      const oculto = await crearAlumno(
        sql,
        { email: emailUnico('oc'), password: PASSWORD, nombre: 'Oculto', edition_id: ed.id },
        null,
      );
      const socio = await usuarioVerificado(sql, 'SOCIO');
      const admin = await usuarioVerificado(sql, 'ADMIN');
      try {
        // Alumno consultable con un campo de ficha privado (linkedin), email visible.
        await actualizarFicha(
          sql,
          alumno.usuario.id,
          { linkedin: 'https://linkedin/kj', privacy: { linkedin: false } },
          null,
        );
        await cambiarEstadoPorUserId(sql, alumno.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, alumno.usuario.id, null);
        await cambiarEstadoPorUserId(sql, oculto.usuario.id, 'activo', null);

        // Sesión del propio alumno (rol ALUMNO) para el 403.
        const vt = await crearTokenVerificacion(sql, alumno.usuario.id);
        await verificarEmail(sql, vt.token);
        const sesionAlumno = await crearSesion(sql, alumno.usuario.id);
        const cookieAlumno = `sesion=${sesionAlumno.token}`;

        const url = `/api/escaparate/alumnos/${alumno.student.id}`;

        // Permisos: 401 sin sesión, 403 ALUMNO y ADMIN.
        expect((await get(app, url)).status).toBe(401);
        expect((await get(app, url, cookieAlumno)).status).toBe(403);
        expect((await get(app, url, admin.cookie)).status).toBe(403);

        // SOCIO verificado: 200 con la ficha + email de contacto; campo privado ausente.
        const res = await get(app, url, socio.cookie);
        expect(res.status).toBe(200);
        const card = (await res.json()) as Record<string, unknown>;
        expect(card.nombre).toBe('Katherine');
        expect(card.email).toBe(emailAlumno);
        expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);

        // Alumno no consultable → 404.
        expect((await get(app, `/api/escaparate/alumnos/${oculto.student.id}`, socio.cookie)).status).toBe(404);
        // Id inexistente → 404.
        expect(
          (await get(app, '/api/escaparate/alumnos/00000000-0000-0000-0000-000000000000', socio.cookie)).status,
        ).toBe(404);
      } finally {
        await borrarUsuario(sql, alumno.usuario.id);
        await borrarUsuario(sql, oculto.usuario.id);
        await borrarUsuario(sql, socio.id);
        await borrarUsuario(sql, admin.id);
        await borrarEdicion(sql, ed.id);
        await sql.end();
      }
    },
  );
});
