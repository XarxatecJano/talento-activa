import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import {
  crearAlumno,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
  actualizarFicha,
} from '../../src/model/student.js';
import { crearItemCatalogo, asociarAlumno, SKILL_CFG } from '../../src/model/catalog.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t26c-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function borrarSkill(sql: ReturnType<typeof createDb>, skillId: string) {
  await sql`delete from "Audit_log" where id_registro = ${skillId}`;
  await sql`delete from "Skill" where id = ${skillId}`;
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

describe('controller/escaparate — GET /api/escaparate/alumnos (búsqueda, solo SOCIO verificado)', () => {
  it.runIf(hasDb)('permisos, validación de filtros y filtrado combinado', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'T26Ctrl', anio: 2026 }, null);
    const skill = await crearItemCatalogo(sql, SKILL_CFG, `Rust-${Date.now()}`, null);

    const alumno = await crearAlumno(
      sql,
      { email: emailUnico('al'), password: PASSWORD, nombre: 'Margaret', edition_id: ed.id },
      null,
    );
    const socio = await usuarioVerificado(sql, 'SOCIO');
    const admin = await usuarioVerificado(sql, 'ADMIN');
    try {
      await actualizarFicha(sql, alumno.usuario.id, { modalidad: 'remoto', estado_laboral: 'buscando' }, null);
      await cambiarEstadoPorUserId(sql, alumno.usuario.id, 'activo', null);
      await registrarConsentimiento(sql, alumno.usuario.id, null);
      await asociarAlumno(sql, SKILL_CFG, alumno.usuario.id, skill.id, 'avanzado', null);

      // Cookie de sesión del propio alumno (rol ALUMNO) para el 403.
      const vt = await crearTokenVerificacion(sql, alumno.usuario.id);
      await verificarEmail(sql, vt.token);
      const sesionAlumno = await crearSesion(sql, alumno.usuario.id);
      const cookieAlumno = `sesion=${sesionAlumno.token}`;

      // Permisos (preceden a la validación de filtros).
      expect((await get(app, '/api/escaparate/alumnos')).status).toBe(401);
      expect((await get(app, '/api/escaparate/alumnos', cookieAlumno)).status).toBe(403);
      expect((await get(app, '/api/escaparate/alumnos', admin.cookie)).status).toBe(403);

      // Validación de filtros (SOCIO autenticado): valores no válidos → 400.
      expect((await get(app, '/api/escaparate/alumnos?modalidad=teletrabajo', socio.cookie)).status).toBe(400);
      expect((await get(app, '/api/escaparate/alumnos?disponibilidad=quizas', socio.cookie)).status).toBe(400);
      expect((await get(app, '/api/escaparate/alumnos?estado_laboral=jubilado', socio.cookie)).status).toBe(400);

      // SOCIO: filtros combinables válidos → 200 con la card del alumno.
      const res = await get(
        app,
        `/api/escaparate/alumnos?edicion=${ed.id}&modalidad=remoto&skill=${skill.id}&estado_laboral=buscando`,
        socio.cookie,
      );
      expect(res.status).toBe(200);
      const cuerpo = (await res.json()) as { id: string; nombre: string }[];
      expect(cuerpo.map((a) => a.nombre)).toEqual(['Margaret']);

      // Filtro que no casa → lista vacía (no 404).
      const vacio = await get(app, `/api/escaparate/alumnos?edicion=${ed.id}&modalidad=presencial`, socio.cookie);
      expect(vacio.status).toBe(200);
      expect(((await vacio.json()) as unknown[]).length).toBe(0);
    } finally {
      await borrarUsuario(sql, alumno.usuario.id);
      await borrarUsuario(sql, socio.id);
      await borrarUsuario(sql, admin.id);
      await borrarSkill(sql, skill.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
