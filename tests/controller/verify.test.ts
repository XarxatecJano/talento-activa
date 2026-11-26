import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createDb } from '../../src/model/db.js';
import { crearUsuario, obtenerUsuarioPublico } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { generarToken } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';
import { requiereAuth, requiereEmailVerificado, type AppEnv } from '../../src/controller/middleware.js';
import type { EnviadorEmail } from '../../src/controller/email.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const DIA_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t11-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function limpiar(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade: tokens y sesiones
}

describe('model/email_verification — token de un solo uso', () => {
  it.runIf(hasDb)('verifica el email, marca el token como usado y es de un solo uso', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('ok'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token, expiresAt } = await crearTokenVerificacion(sql, u.id);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      expect(await verificarEmail(sql, token)).toBe(true);
      const tras = await obtenerUsuarioPublico(sql, u.id);
      expect(tras?.email_verified).toBe(true);

      // Un solo uso: el mismo token ya no vale.
      expect(await verificarEmail(sql, token)).toBe(false);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('token caducado → false y el email sigue sin verificar', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('exp'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearTokenVerificacion(sql, u.id);
      await sql`update "Email_verification_token" set expires_at = ${new Date(Date.now() - DIA_MS)} where user_id = ${u.id}`;

      expect(await verificarEmail(sql, token)).toBe(false);
      expect((await obtenerUsuarioPublico(sql, u.id))?.email_verified).toBe(false);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('token inexistente → false', async () => {
    const sql = createDb();
    try {
      expect(await verificarEmail(sql, generarToken())).toBe(false);
    } finally {
      await sql.end();
    }
  });
});

describe('controller — POST /api/auth/verify', () => {
  it.runIf(hasDb)('token válido → 200 y usuario verificado; inválido → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('ep'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearTokenVerificacion(sql, u.id);

      const ok = await app.request('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(ok.status).toBe(200);
      expect((await obtenerUsuarioPublico(sql, u.id))?.email_verified).toBe(true);

      const mal = await app.request('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'no-existe' }),
      });
      expect(mal.status).toBe(400);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });
});

describe('controller — register envía la verificación', () => {
  it.runIf(hasDb)('al registrar, se envía un token que verifica al nuevo usuario', async () => {
    const sql = createDb();
    const capturado: { destino?: string; token?: string } = {};
    const enviador: EnviadorEmail = {
      async enviarVerificacion(destino, token) {
        capturado.destino = destino;
        capturado.token = token;
      },
    };
    const app = crearApp(sql, { enviador });
    const admin = await crearUsuario(sql, { email: emailUnico('admin'), password: PASSWORD, rol: 'ADMIN' });
    const { token: cookieTok } = await crearSesion(sql, admin.id);
    let nuevoId: string | undefined;
    try {
      const email = emailUnico('inv');
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `sesion=${cookieTok}` },
        body: JSON.stringify({ email, password: PASSWORD, rol: 'ALUMNO' }),
      });
      expect(res.status).toBe(201);
      nuevoId = ((await res.json()) as { id: string }).id;

      expect(capturado.destino).toBe(email);
      expect(capturado.token).toBeTruthy();
      expect(await verificarEmail(sql, capturado.token!)).toBe(true);
    } finally {
      if (nuevoId) await limpiar(sql, nuevoId);
      await limpiar(sql, admin.id);
      await sql.end();
    }
  });
});

describe('controller/middleware — requiereEmailVerificado', () => {
  function appGuardada(sql: ReturnType<typeof createDb>) {
    const app = new Hono<AppEnv>();
    app.get('/verificado', requiereAuth(sql), requiereEmailVerificado(sql), (c) => c.json({ ok: true }));
    return app;
  }

  it.runIf(hasDb)('usuario sin verificar → 403; verificado → 200', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('mw'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token: cookieTok } = await crearSesion(sql, u.id);
      const app = appGuardada(sql);

      const sinVerificar = await app.request('/verificado', { headers: { Cookie: `sesion=${cookieTok}` } });
      expect(sinVerificar.status).toBe(403);

      const { token } = await crearTokenVerificacion(sql, u.id);
      await verificarEmail(sql, token);

      const verificado = await app.request('/verificado', { headers: { Cookie: `sesion=${cookieTok}` } });
      expect(verificado.status).toBe(200);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });
});
