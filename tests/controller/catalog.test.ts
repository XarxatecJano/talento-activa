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
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const emailUnico = (p: string) => `t19-${uniq(p)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function verificado(sql: ReturnType<typeof createDb>, rol: 'ADMIN' | 'SOCIO') {
  const u = await crearUsuario(sql, { email: emailUnico(rol.toLowerCase()), password: PASSWORD, rol });
  const vt = await crearTokenVerificacion(sql, u.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, u.id);
  return { id: u.id, cookie: `sesion=${token}` };
}
async function alumno(sql: ReturnType<typeof createDb>, edId: string) {
  const { usuario, student } = await crearAlumno(sql, { email: emailUnico('al'), password: PASSWORD, nombre: 'Dev', edition_id: edId }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { userId: usuario.id, studentId: student.id, cookie: `sesion=${token}` };
}
function rq(app: ReturnType<typeof crearApp>, path: string, method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('controller/catalog — catálogo de skills (admin) y asociación del alumno', () => {
  it.runIf(hasDb)('admin crea skill (201, auditado); no-admin 403; duplicado 409; cualquiera lista', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const adm = await verificado(sql, 'ADMIN');
    const socio = await verificado(sql, 'SOCIO');
    let skillId: string | undefined;
    try {
      const nombre = uniq('React');
      const res = await rq(app, '/api/skills', 'POST', adm.cookie, { nombre });
      expect(res.status).toBe(201);
      const skill = (await res.json()) as { id: string; nombre: string };
      skillId = skill.id;
      expect(skill.nombre).toBe(nombre);

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Skill' and id_registro = ${skill.id} and operacion = 'INSERT'`;
      expect(audit).toHaveLength(1);

      expect((await rq(app, '/api/skills', 'POST', socio.cookie, { nombre: uniq('X') })).status).toBe(403);
      expect((await rq(app, '/api/skills', 'POST', adm.cookie, { nombre })).status).toBe(409);

      const lista = (await (await rq(app, '/api/skills', 'GET', socio.cookie)).json()) as { id: string }[];
      expect(lista.some((s) => s.id === skill.id)).toBe(true);
    } finally {
      if (skillId) await sql`delete from "Audit_log" where id_registro = ${skillId}`;
      if (skillId) await sql`delete from "Skill" where id = ${skillId}`;
      await borrarUsuario(sql, adm.id);
      await borrarUsuario(sql, socio.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('el alumno asocia una skill con nivel (upsert), la lista, y valida', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const adm = await verificado(sql, 'ADMIN');
    const ed = await crearEdicion(sql, { nombre: 'CatEd', anio: 2026 }, null);
    const a = await alumno(sql, ed.id);
    let skillId: string | undefined;
    try {
      const skill = (await (await rq(app, '/api/skills', 'POST', adm.cookie, { nombre: uniq('TS') })).json()) as { id: string };
      skillId = skill.id;

      // Upsert nivel basico → medio.
      expect((await rq(app, `/api/alumnos/me/skills/${skill.id}`, 'PUT', a.cookie, { nivel: 'basico' })).status).toBe(200);
      expect((await rq(app, `/api/alumnos/me/skills/${skill.id}`, 'PUT', a.cookie, { nivel: 'medio' })).status).toBe(200);

      const mias = (await (await rq(app, '/api/alumnos/me/skills', 'GET', a.cookie)).json()) as { id: string; nombre: string; nivel: string }[];
      const entrada = mias.find((s) => s.id === skill.id);
      expect(entrada?.nivel).toBe('medio');

      // Nivel inválido → 400; skill inexistente → 404.
      expect((await rq(app, `/api/alumnos/me/skills/${skill.id}`, 'PUT', a.cookie, { nivel: 'experto' })).status).toBe(400);
      expect((await rq(app, '/api/alumnos/me/skills/00000000-0000-0000-0000-000000000000', 'PUT', a.cookie, { nivel: 'medio' })).status).toBe(404);

      // Desasociar.
      expect((await rq(app, `/api/alumnos/me/skills/${skill.id}`, 'DELETE', a.cookie)).status).toBe(204);
      const tras = (await (await rq(app, '/api/alumnos/me/skills', 'GET', a.cookie)).json()) as { id: string }[];
      expect(tras.some((s) => s.id === skill.id)).toBe(false);
    } finally {
      await borrarUsuario(sql, a.userId);
      if (skillId) {
        await sql`delete from "Audit_log" where id_registro = ${skillId}`;
        await sql`delete from "Skill" where id = ${skillId}`;
      }
      await borrarUsuario(sql, adm.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('idiomas: admin crea idioma y el alumno lo asocia con nivel (B2)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const adm = await verificado(sql, 'ADMIN');
    const ed = await crearEdicion(sql, { nombre: 'CatEdL', anio: 2026 }, null);
    const a = await alumno(sql, ed.id);
    let langId: string | undefined;
    try {
      const idioma = (await (await rq(app, '/api/idiomas', 'POST', adm.cookie, { nombre: uniq('Inglés') })).json()) as { id: string };
      langId = idioma.id;

      expect((await rq(app, `/api/alumnos/me/idiomas/${idioma.id}`, 'PUT', a.cookie, { nivel: 'B2' })).status).toBe(200);
      expect((await rq(app, `/api/alumnos/me/idiomas/${idioma.id}`, 'PUT', a.cookie, { nivel: 'Z9' })).status).toBe(400);

      const mios = (await (await rq(app, '/api/alumnos/me/idiomas', 'GET', a.cookie)).json()) as { id: string; nivel: string }[];
      expect(mios.find((l) => l.id === idioma.id)?.nivel).toBe('B2');
    } finally {
      await borrarUsuario(sql, a.userId);
      if (langId) {
        await sql`delete from "Audit_log" where id_registro = ${langId}`;
        await sql`delete from "Language" where id = ${langId}`;
      }
      await borrarUsuario(sql, adm.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
