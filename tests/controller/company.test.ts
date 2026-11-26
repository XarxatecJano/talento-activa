import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';
import type { EnviadorEmail } from '../../src/controller/email.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t14-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade: Company_user_rel, tokens, sesiones
}
async function borrarEmpresa(sql: ReturnType<typeof createDb>, companyId: string) {
  await sql`delete from "Audit_log" where id_registro = ${companyId}`;
  await sql`delete from "Company" where id = ${companyId}`; // cascade: Company_user_rel
}
async function admin(sql: ReturnType<typeof createDb>) {
  const u = await crearUsuario(sql, { email: emailUnico('admin'), password: PASSWORD, rol: 'ADMIN' });
  const { token } = await crearSesion(sql, u.id);
  return { adminId: u.id, cookie: `sesion=${token}` };
}
function req(app: ReturnType<typeof crearApp>, path: string, method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('controller/company — alta de empresas (solo ADMIN)', () => {
  it.runIf(hasDb)('sin sesión → 401; no-admin → 403', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let userId: string | undefined;
    try {
      expect((await req(app, '/api/empresas', 'POST', undefined, {})).status).toBe(401);
      const u = await crearUsuario(sql, { email: emailUnico('al'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      expect((await req(app, '/api/empresas', 'POST', `sesion=${token}`, { nombre: 'E', email: emailUnico('e'), password: PASSWORD })).status).toBe(403);
    } finally {
      if (userId) await borrarUsuario(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('ADMIN crea empresa: Company + usuario SOCIO vinculado, audita y envía verificación', async () => {
    const sql = createDb();
    const capturado: { destino?: string; token?: string } = {};
    const enviador: EnviadorEmail = {
      async enviarVerificacion(d, t) {
        capturado.destino = d;
        capturado.token = t;
      },
    };
    const app = crearApp(sql, { enviador });
    const { adminId, cookie } = await admin(sql);
    let socioId: string | undefined;
    let companyId: string | undefined;
    try {
      const email = emailUnico('socio');
      const res = await req(app, '/api/empresas', 'POST', cookie, {
        nombre: 'Acme S.L.',
        contacto: 'rrhh@acme.test',
        es_socia: true,
        email,
        password: PASSWORD,
      });
      expect(res.status).toBe(201);
      const cuerpo = (await res.json()) as {
        company: { id: string; nombre: string; es_socia: boolean; contacto: string | null };
        usuario: { id: string; rol: string; email_verified: boolean };
      };
      socioId = cuerpo.usuario.id;
      companyId = cuerpo.company.id;

      expect(cuerpo.usuario.rol).toBe('SOCIO');
      expect(cuerpo.usuario.email_verified).toBe(false);
      expect(cuerpo.company).toMatchObject({ nombre: 'Acme S.L.', es_socia: true, contacto: 'rrhh@acme.test' });

      const rel = await sql`select 1 from "Company_user_rel" where company_id = ${cuerpo.company.id} and user_id = ${cuerpo.usuario.id}`;
      expect(rel).toHaveLength(1);
      const audit = await sql`select 1 from "Audit_log" where tabla = 'Company' and id_registro = ${cuerpo.company.id} and operacion = 'INSERT'`;
      expect(audit).toHaveLength(1);
      expect(capturado.destino).toBe(email);
      expect(capturado.token).toBeTruthy();
    } finally {
      if (socioId) await borrarUsuario(sql, socioId);
      if (companyId) await borrarEmpresa(sql, companyId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('marcar es_socia (PATCH) actualiza y audita; 404 si no existe', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    let socioId: string | undefined;
    let companyId: string | undefined;
    try {
      const creada = (await (await req(app, '/api/empresas', 'POST', cookie, { nombre: 'NoSocia', email: emailUnico('s'), password: PASSWORD })).json()) as {
        company: { id: string; es_socia: boolean };
        usuario: { id: string };
      };
      socioId = creada.usuario.id;
      companyId = creada.company.id;
      expect(creada.company.es_socia).toBe(false); // por defecto

      const res = await req(app, `/api/empresas/${creada.company.id}`, 'PATCH', cookie, { es_socia: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { es_socia: boolean }).es_socia).toBe(true);

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Company' and id_registro = ${creada.company.id} and operacion = 'UPDATE'`;
      expect(audit).toHaveLength(1);

      expect((await req(app, '/api/empresas/00000000-0000-0000-0000-000000000000', 'PATCH', cookie, { es_socia: true })).status).toBe(404);
    } finally {
      if (socioId) await borrarUsuario(sql, socioId);
      if (companyId) await borrarEmpresa(sql, companyId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('lista y obtiene por id; duplicado → 409; body inválido → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    let socioId: string | undefined;
    let companyId: string | undefined;
    try {
      const email = emailUnico('dup');
      const creada = (await (await req(app, '/api/empresas', 'POST', cookie, { nombre: 'ListaCo', email, password: PASSWORD })).json()) as {
        company: { id: string };
        usuario: { id: string };
      };
      socioId = creada.usuario.id;
      companyId = creada.company.id;

      const lista = (await (await req(app, '/api/empresas', 'GET', cookie)).json()) as { id: string }[];
      expect(lista.some((e) => e.id === creada.company.id)).toBe(true);
      expect((await req(app, `/api/empresas/${creada.company.id}`, 'GET', cookie)).status).toBe(200);

      expect((await req(app, '/api/empresas', 'POST', cookie, { nombre: 'Otra', email: email.toUpperCase(), password: PASSWORD })).status).toBe(409);
      expect((await req(app, '/api/empresas', 'POST', cookie, { nombre: '', email: emailUnico('z'), password: PASSWORD })).status).toBe(400);
    } finally {
      if (socioId) await borrarUsuario(sql, socioId);
      if (companyId) await borrarEmpresa(sql, companyId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });
});
