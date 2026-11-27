import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEmpresa } from '../../src/model/company.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { enviadorNoop } from '../../src/controller/email.js';
import { crearApp } from '../../src/controller/app.js';

// Integración del hallazgo MEDIO 1 (revisión 2026-11-26): un identificador
// no-UUID en ruta/query/body que acabaría comparándose con una columna `uuid`
// debe traducirse a 404/400 en el controlador, nunca a un 500 por el error
// `22P02` de Postgres. Requiere BD (sesión real); si no la hay, se salta.

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `uuid-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
const MALO = 'no-es-uuid';

type Db = ReturnType<typeof createDb>;

function reqJson(
  app: ReturnType<typeof crearApp>,
  path: string,
  method: string,
  cookie?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function borrarUsuario(sql: Db, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEmpresa(sql: Db, companyId: string) {
  await sql`delete from "Audit_log" where id_registro = ${companyId}`;
  await sql`delete from "Company" where id = ${companyId}`;
}

/** ADMIN verificado con sesión. */
async function adminVerificado(sql: Db) {
  const usuario = await crearUsuario(sql, { email: emailUnico('admin'), password: PASSWORD, rol: 'ADMIN' }, null);
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { userId: usuario.id, cookie: `sesion=${token}` };
}

/** SOCIO verificado con empresa vinculada. */
async function socioVerificado(sql: Db) {
  const { usuario, company } = await crearEmpresa(
    sql,
    { nombre: 'Acme', email: emailUnico('socio'), password: PASSWORD, es_socia: true },
    null,
  );
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { userId: usuario.id, companyId: company.id, cookie: `sesion=${token}` };
}

describe('controller — identificadores no-UUID no provocan 500 (MEDIO 1)', () => {
  it.runIf(hasDb)('rutas :id de ADMIN con id no-UUID → 404 (no 500)', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const admin = await adminVerificado(sql);
    try {
      const casos: [string, string][] = [
        ['GET', `/api/ediciones/${MALO}`],
        ['POST', `/api/ediciones/${MALO}/cerrar`],
        ['DELETE', `/api/alumnos/${MALO}`],
        ['GET', `/api/empresas/${MALO}`],
        ['DELETE', `/api/alumnos/${MALO}/empresa-actual`],
      ];
      for (const [method, path] of casos) {
        const res = await reqJson(app, path, method, admin.cookie);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      // PATCH con body válido pero id no-UUID → 404.
      expect(
        (await reqJson(app, `/api/alumnos/${MALO}/estado`, 'PATCH', admin.cookie, { estado: 'activo' })).status,
      ).toBe(404);
      expect(
        (await reqJson(app, `/api/empresas/${MALO}`, 'PATCH', admin.cookie, { es_socia: true })).status,
      ).toBe(404);
    } finally {
      await borrarUsuario(sql, admin.userId);
    }
  });

  it.runIf(hasDb)('PUT empresa-actual: alumno no-UUID → 404; company_id no-UUID → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const admin = await adminVerificado(sql);
    const socio = await socioVerificado(sql);
    try {
      // alumno :id no-UUID (company_id válido) → 404.
      expect(
        (await reqJson(app, `/api/alumnos/${MALO}/empresa-actual`, 'PUT', admin.cookie, { company_id: socio.companyId })).status,
      ).toBe(404);
      // company_id no-UUID (alumno válido en forma) → 400, antes de tocar la BD.
      const alumnoUuid = '00000000-0000-0000-0000-000000000000';
      expect(
        (await reqJson(app, `/api/alumnos/${alumnoUuid}/empresa-actual`, 'PUT', admin.cookie, { company_id: MALO })).status,
      ).toBe(400);
    } finally {
      await borrarEmpresa(sql, socio.companyId);
      await borrarUsuario(sql, admin.userId);
    }
  });

  it.runIf(hasDb)('rutas de escaparate (SOCIO) con id/filtro no-UUID → 404/400 (no 500)', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const socio = await socioVerificado(sql);
    try {
      // :id no-UUID → 404.
      expect((await reqJson(app, `/api/escaparate/ediciones/${MALO}`, 'GET', socio.cookie)).status).toBe(404);
      expect((await reqJson(app, `/api/escaparate/alumnos/${MALO}`, 'GET', socio.cookie)).status).toBe(404);
      expect((await reqJson(app, `/api/alumnos/${MALO}`, 'GET', socio.cookie)).status).toBe(404);
      expect((await reqJson(app, `/api/escaparate/bookmarks/${MALO}`, 'PUT', socio.cookie)).status).toBe(404);
      expect((await reqJson(app, `/api/escaparate/bookmarks/${MALO}`, 'DELETE', socio.cookie)).status).toBe(404);
      // filtros ?skill / ?edicion no-UUID → 400.
      expect((await reqJson(app, `/api/escaparate/alumnos?skill=${MALO}`, 'GET', socio.cookie)).status).toBe(400);
      expect((await reqJson(app, `/api/escaparate/alumnos?edicion=${MALO}`, 'GET', socio.cookie)).status).toBe(400);
      // sin filtros → 200 (listar visibles).
      expect((await reqJson(app, '/api/escaparate/alumnos', 'GET', socio.cookie)).status).toBe(200);
    } finally {
      await borrarEmpresa(sql, socio.companyId);
    }
  });
});
