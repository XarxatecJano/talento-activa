import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t12-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
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

describe('controller/edition — CRUD de ediciones (solo ADMIN)', () => {
  it.runIf(hasDb)('sin sesión → 401; no-admin → 403', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let userId: string | undefined;
    try {
      expect((await req(app, '/api/ediciones', 'POST', undefined, { nombre: 'E', anio: 2026 })).status).toBe(401);
      const u = await crearUsuario(sql, { email: emailUnico('a'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      expect((await req(app, '/api/ediciones', 'POST', `sesion=${token}`, { nombre: 'E', anio: 2026 })).status).toBe(403);
    } finally {
      if (userId) await borrarUsuario(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('crea una edición (201, estado=abierta) y la audita', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    let edId: string | undefined;
    try {
      const res = await req(app, '/api/ediciones', 'POST', cookie, { nombre: 'Promo 2026', anio: 2026 });
      expect(res.status).toBe(201);
      const ed = (await res.json()) as { id: string; nombre: string; anio: number; estado: string };
      edId = ed.id;
      expect(ed).toMatchObject({ nombre: 'Promo 2026', anio: 2026, estado: 'abierta' });

      const audit = await sql<{ operacion: string }[]>`
        select operacion from "Audit_log" where tabla = 'Edition' and id_registro = ${ed.id}
      `;
      expect(audit[0]?.operacion).toBe('INSERT');
    } finally {
      if (edId) await borrarEdicion(sql, edId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('lista y obtiene por id (404 si no existe)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    let edId: string | undefined;
    try {
      const creada = (await (await req(app, '/api/ediciones', 'POST', cookie, { nombre: 'Lista', anio: 2025 })).json()) as { id: string };
      edId = creada.id;

      const lista = (await (await req(app, '/api/ediciones', 'GET', cookie)).json()) as { id: string }[];
      expect(lista.some((e) => e.id === creada.id)).toBe(true);

      expect((await req(app, `/api/ediciones/${creada.id}`, 'GET', cookie)).status).toBe(200);
      expect((await req(app, '/api/ediciones/00000000-0000-0000-0000-000000000000', 'GET', cookie)).status).toBe(404);
    } finally {
      if (edId) await borrarEdicion(sql, edId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('cierra una edición (estado=cerrada) y audita UPDATE; 404 si no existe', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    let edId: string | undefined;
    try {
      const creada = (await (await req(app, '/api/ediciones', 'POST', cookie, { nombre: 'Cerrar', anio: 2024 })).json()) as { id: string };
      edId = creada.id;

      const res = await req(app, `/api/ediciones/${creada.id}/cerrar`, 'POST', cookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { estado: string }).estado).toBe('cerrada');

      const audit = await sql<{ operacion: string }[]>`
        select operacion from "Audit_log" where tabla = 'Edition' and id_registro = ${creada.id} and operacion = 'UPDATE'
      `;
      expect(audit).toHaveLength(1);

      expect((await req(app, '/api/ediciones/00000000-0000-0000-0000-000000000000/cerrar', 'POST', cookie)).status).toBe(404);
    } finally {
      if (edId) await borrarEdicion(sql, edId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('body inválido → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    try {
      expect((await req(app, '/api/ediciones', 'POST', cookie, { nombre: '', anio: 2026 })).status).toBe(400);
      expect((await req(app, '/api/ediciones', 'POST', cookie, { nombre: 'X', anio: 'dos mil' })).status).toBe(400);
    } finally {
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });
});
