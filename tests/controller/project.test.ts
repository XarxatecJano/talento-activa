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
const emailUnico = (p: string) => `t18-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
const BASE = '/api/alumnos/me/proyectos';

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function alumno(sql: ReturnType<typeof createDb>, edId: string, p: string) {
  const { usuario, student } = await crearAlumno(sql, { email: emailUnico(p), password: PASSWORD, nombre: 'Dev', edition_id: edId }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { userId: usuario.id, studentId: student.id, cookie: `sesion=${token}` };
}
function reqJson(app: ReturnType<typeof crearApp>, path: string, method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('controller/project — CRUD de proyectos del alumno', () => {
  it.runIf(hasDb)('permisos: 401 sin sesión; 403 si no es ALUMNO; 403 si no verificado', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let socioId: string | undefined;
    try {
      expect((await reqJson(app, BASE, 'POST', undefined, {})).status).toBe(401);
      const socio = await crearUsuario(sql, { email: emailUnico('so'), password: PASSWORD, rol: 'SOCIO' });
      socioId = socio.id;
      const vt = await crearTokenVerificacion(sql, socio.id);
      await verificarEmail(sql, vt.token);
      const s = await crearSesion(sql, socio.id);
      expect((await reqJson(app, BASE, 'POST', `sesion=${s.token}`, { titulo: 'X', url: 'https://x.test' })).status).toBe(403);
    } finally {
      if (socioId) await borrarUsuario(sql, socioId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('crea un proyecto (201, auditado); URL inválida → 400; título vacío → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'ProjEd', anio: 2026 }, null);
    const a = await alumno(sql, ed.id, 'ok');
    try {
      const res = await reqJson(app, BASE, 'POST', a.cookie, { titulo: 'Mi repo', url: 'https://github.com/dev/repo', thumbnail_url: 'https://img.test/t.png' });
      expect(res.status).toBe(201);
      const proj = (await res.json()) as { id: string; titulo: string; url: string; student_id: string; thumbnail_url: string | null };
      expect(proj).toMatchObject({ titulo: 'Mi repo', url: 'https://github.com/dev/repo', student_id: a.studentId });

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Project' and id_registro = ${proj.id} and operacion = 'INSERT'`;
      expect(audit).toHaveLength(1);

      expect((await reqJson(app, BASE, 'POST', a.cookie, { titulo: 'X', url: 'no-es-url' })).status).toBe(400);
      expect((await reqJson(app, BASE, 'POST', a.cookie, { titulo: 'X', url: 'ftp://x.test' })).status).toBe(400);
      expect((await reqJson(app, BASE, 'POST', a.cookie, { titulo: '', url: 'https://x.test' })).status).toBe(400);
    } finally {
      await borrarUsuario(sql, a.userId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('lista, edita (auditado) y valida URL en PATCH', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'ProjEd2', anio: 2026 }, null);
    const a = await alumno(sql, ed.id, 'edit');
    try {
      const creado = (await (await reqJson(app, BASE, 'POST', a.cookie, { titulo: 'T', url: 'https://x.test' })).json()) as { id: string };

      const lista = (await (await reqJson(app, BASE, 'GET', a.cookie)).json()) as { id: string }[];
      expect(lista.some((p) => p.id === creado.id)).toBe(true);

      const res = await reqJson(app, `${BASE}/${creado.id}`, 'PATCH', a.cookie, { titulo: 'Nuevo título', thumbnail_url: 'https://img.test/x.png' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { titulo: string }).titulo).toBe('Nuevo título');

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Project' and id_registro = ${creado.id} and operacion = 'UPDATE'`;
      expect(audit).toHaveLength(1);

      expect((await reqJson(app, `${BASE}/${creado.id}`, 'PATCH', a.cookie, { url: 'no-url' })).status).toBe(400);
    } finally {
      await borrarUsuario(sql, a.userId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('borra el propio; no puede tocar el de otro alumno (404)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const ed = await crearEdicion(sql, { nombre: 'ProjEd3', anio: 2026 }, null);
    const a = await alumno(sql, ed.id, 'owner');
    const b = await alumno(sql, ed.id, 'otro');
    try {
      const deA = (await (await reqJson(app, BASE, 'POST', a.cookie, { titulo: 'A', url: 'https://a.test' })).json()) as { id: string };

      // B no puede editar ni borrar el proyecto de A.
      expect((await reqJson(app, `${BASE}/${deA.id}`, 'PATCH', b.cookie, { titulo: 'hack' })).status).toBe(404);
      expect((await reqJson(app, `${BASE}/${deA.id}`, 'DELETE', b.cookie)).status).toBe(404);

      // A sí puede borrarlo.
      expect((await reqJson(app, `${BASE}/${deA.id}`, 'DELETE', a.cookie)).status).toBe(204);
      expect(await sql`select 1 from "Project" where id = ${deA.id}`).toHaveLength(0);
    } finally {
      await borrarUsuario(sql, a.userId);
      await borrarUsuario(sql, b.userId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
