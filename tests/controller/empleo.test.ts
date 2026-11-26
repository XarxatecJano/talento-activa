import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearEmpresa } from '../../src/model/company.js';
import {
  crearAlumno,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
} from '../../src/model/student.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t29c-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

type Db = ReturnType<typeof createDb>;

async function borrarUsuario(sql: Db, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEmpresa(sql: Db, companyId: string) {
  await sql`delete from "Audit_log" where id_registro = ${companyId}`;
  await sql`delete from "Company" where id = ${companyId}`;
}
async function borrarEdicion(sql: Db, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

const enviadorNoop = { async enviarVerificacion() {} };

/** SOCIO verificado con empresa vinculada. */
async function socioConEmpresa(sql: Db) {
  const { usuario, company } = await crearEmpresa(
    sql,
    { nombre: 'Consultora', email: emailUnico('socio'), password: PASSWORD, es_socia: true },
    null,
  );
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { socioId: usuario.id, companyId: company.id, cookie: `sesion=${token}` };
}

/** ADMIN con sesión. */
async function adminConSesion(sql: Db) {
  const admin = await crearUsuario(sql, { email: emailUnico('ad'), password: PASSWORD, rol: 'ADMIN' });
  const { token } = await crearSesion(sql, admin.id);
  return { adminId: admin.id, cookie: `sesion=${token}` };
}

async function alumnoVisible(sql: Db, edId: string, nombre: string) {
  const al = await crearAlumno(
    sql,
    { email: emailUnico('al'), password: PASSWORD, nombre, edition_id: edId },
    null,
  );
  await cambiarEstadoPorUserId(sql, al.usuario.id, 'activo', null);
  await registrarConsentimiento(sql, al.usuario.id, null);
  return al;
}

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

describe('controller/empleo — T29 alumnos en empresas socias', () => {
  it.runIf(hasDb)('permisos: asignar/quitar solo ADMIN; sección solo SOCIO verificado', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'P', anio: 2026 }, null);
    const al = await alumnoVisible(sql, ed.id, 'Ana');
    const socio = await socioConEmpresa(sql);
    // ALUMNO verificado con sesión.
    const vt = await crearTokenVerificacion(sql, al.usuario.id);
    await verificarEmail(sql, vt.token);
    const { token: alTok } = await crearSesion(sql, al.usuario.id);
    try {
      const sid = al.student.id;
      // PUT/DELETE empresa-actual: solo ADMIN (401 sin sesión; 403 SOCIO/ALUMNO).
      for (const [method, path] of [
        ['PUT', `/api/alumnos/${sid}/empresa-actual`],
        ['DELETE', `/api/alumnos/${sid}/empresa-actual`],
      ] as const) {
        expect((await reqJson(app, path, method, undefined, { company_id: socio.companyId })).status).toBe(401);
        expect((await reqJson(app, path, method, socio.cookie, { company_id: socio.companyId })).status).toBe(403);
        expect((await reqJson(app, path, method, `sesion=${alTok}`, { company_id: socio.companyId })).status).toBe(403);
      }
      // GET sección: solo SOCIO (401 sin sesión; 403 ALUMNO).
      expect((await reqJson(app, '/api/escaparate/empresas-socias', 'GET')).status).toBe(401);
      expect((await reqJson(app, '/api/escaparate/empresas-socias', 'GET', `sesion=${alTok}`)).status).toBe(403);
      expect((await reqJson(app, '/api/escaparate/empresas-socias', 'GET', socio.cookie)).status).toBe(200);
    } finally {
      await borrarUsuario(sql, al.usuario.id);
      await borrarEmpresa(sql, socio.companyId);
      await borrarUsuario(sql, socio.socioId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('admin asigna a empresa socia → aparece en la sección; quitar → desaparece', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'P2', anio: 2026 }, null);
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    const admin = await adminConSesion(sql);
    const socio = await socioConEmpresa(sql); // su empresa es socia
    try {
      const sid = ana.student.id;
      // Asignar.
      expect(
        (await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'PUT', admin.cookie, { company_id: socio.companyId })).status,
      ).toBe(204);
      // Sección (consultada por el SOCIO): Ana con su empresa.
      let res = await reqJson(app, '/api/escaparate/empresas-socias', 'GET', socio.cookie);
      expect(res.status).toBe(200);
      let cards = (await res.json()) as { id: string; nombre: string; empresa: { id: string; nombre: string } }[];
      const card = cards.find((c) => c.id === sid)!;
      expect(card.nombre).toBe('Ana');
      expect(card.empresa).toEqual({ id: socio.companyId, nombre: 'Consultora' });

      // Quitar (idempotente).
      expect((await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'DELETE', admin.cookie)).status).toBe(204);
      expect((await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'DELETE', admin.cookie)).status).toBe(204);
      res = await reqJson(app, '/api/escaparate/empresas-socias', 'GET', socio.cookie);
      cards = (await res.json()) as typeof cards;
      expect(cards.find((c) => c.id === sid)).toBeUndefined();
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarEmpresa(sql, socio.companyId);
      await borrarUsuario(sql, socio.socioId);
      await borrarUsuario(sql, admin.adminId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('validación: body sin company_id → 400; alumno inexistente → 404; empresa no socia/inexistente → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'P3', anio: 2026 }, null);
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    const admin = await adminConSesion(sql);
    const { company: noSocia } = await crearEmpresa(
      sql,
      { nombre: 'NoSocia', email: emailUnico('ns'), password: PASSWORD, es_socia: false },
      null,
    );
    try {
      const sid = ana.student.id;
      const cero = '00000000-0000-0000-0000-000000000000';
      // Body inválido.
      expect((await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'PUT', admin.cookie, {})).status).toBe(400);
      // Empresa no socia → 400.
      expect(
        (await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'PUT', admin.cookie, { company_id: noSocia.id })).status,
      ).toBe(400);
      // Empresa inexistente → 400.
      expect(
        (await reqJson(app, `/api/alumnos/${sid}/empresa-actual`, 'PUT', admin.cookie, { company_id: cero })).status,
      ).toBe(400);
      // Alumno inexistente → 404 (empresa socia válida).
      const socio = await socioConEmpresa(sql);
      try {
        expect(
          (await reqJson(app, `/api/alumnos/${cero}/empresa-actual`, 'PUT', admin.cookie, { company_id: socio.companyId })).status,
        ).toBe(404);
        // Quitar en alumno inexistente → 404.
        expect((await reqJson(app, `/api/alumnos/${cero}/empresa-actual`, 'DELETE', admin.cookie)).status).toBe(404);
      } finally {
        await borrarEmpresa(sql, socio.companyId);
        await borrarUsuario(sql, socio.socioId);
      }
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarEmpresa(sql, noSocia.id);
      await borrarUsuario(sql, admin.adminId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
