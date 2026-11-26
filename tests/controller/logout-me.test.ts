import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion, resolverSesion } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const DIA_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t08-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function limpiar(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}

describe('controller/logout — POST /api/auth/logout', () => {
  it.runIf(hasDb)('borra la sesión, limpia la cookie y responde 204', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('out');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);

      const res = await app.request('/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: `sesion=${token}` },
      });
      expect(res.status).toBe(204);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('sesion=;');
      expect(setCookie).toContain(`Expires=${new Date(0).toUTCString()}`);

      expect(await resolverSesion(sql, token)).toBeNull();
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('es idempotente: sin cookie también responde 204 y limpia', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await app.request('/api/auth/logout', { method: 'POST' });
      expect(res.status).toBe(204);
      expect(res.headers.get('set-cookie') ?? '').toContain('sesion=;');
    } finally {
      await sql.end();
    }
  });
});

describe('controller/me — GET /api/me', () => {
  it.runIf(hasDb)('con sesión válida → 200 y proyección pública sin hash', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('me');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'SOCIO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);

      const res = await app.request('/api/me', { headers: { Cookie: `sesion=${token}` } });
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo).toMatchObject({ id: u.id, email, rol: 'SOCIO', email_verified: false });
      expect(cuerpo).not.toHaveProperty('password_hash');
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('sin cookie → 401', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await app.request('/api/me');
      expect(res.status).toBe(401);
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('token inválido → 401', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await app.request('/api/me', { headers: { Cookie: 'sesion=token-que-no-existe' } });
      expect(res.status).toBe(401);
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('renovación deslizante → 200 y repone la cookie (mismo token)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('renew');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      await sql`update "Session" set expires_at = ${new Date(Date.now() + 10 * DIA_MS)} where user_id = ${u.id}`;

      const res = await app.request('/api/me', { headers: { Cookie: `sesion=${token}` } });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(`sesion=${token}`); // mismo token, nueva caducidad
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });
});
