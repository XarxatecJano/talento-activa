import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { requiereAuth, requiereRol, type AppEnv } from '../../src/controller/middleware.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t09-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

function appDePrueba(sql: ReturnType<typeof createDb>) {
  const app = new Hono<AppEnv>();
  app.get('/privado', requiereAuth(sql), (c) => c.json(c.get('actor')));
  app.get('/solo-admin', requiereAuth(sql), requiereRol('ADMIN'), (c) => c.json(c.get('actor')));
  return app;
}

async function limpiar(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}

describe('controller/middleware — requiereAuth / requiereRol', () => {
  it.runIf(hasDb)('sin cookie → 401', async () => {
    const sql = createDb();
    try {
      const res = await appDePrueba(sql).request('/privado');
      expect(res.status).toBe(401);
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('sesión válida → 200 con el Actor en el contexto', async () => {
    const sql = createDb();
    const email = emailUnico('ok');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      const res = await appDePrueba(sql).request('/privado', { headers: { Cookie: `sesion=${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: u.id, rol: 'ALUMNO' });
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('rol insuficiente → 403', async () => {
    const sql = createDb();
    const email = emailUnico('noadmin');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      const res = await appDePrueba(sql).request('/solo-admin', { headers: { Cookie: `sesion=${token}` } });
      expect(res.status).toBe(403);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('rol permitido → 200', async () => {
    const sql = createDb();
    const email = emailUnico('admin');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ADMIN' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      const res = await appDePrueba(sql).request('/solo-admin', { headers: { Cookie: `sesion=${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: u.id, rol: 'ADMIN' });
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });
});
