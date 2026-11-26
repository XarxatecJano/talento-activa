import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion, resolverSesion } from '../../src/model/session.js';
import { leerTokenCookie } from '../../src/controller/cookie.js';
import { crearApp } from '../../src/controller/app.js';
import { autenticar } from '../../src/controller/auth.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t07-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

function postLogin(app: ReturnType<typeof crearApp>, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function limpiar(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade borra Session
}

describe('controller/login — POST /api/auth/login', () => {
  it.runIf(hasDb)('credenciales válidas → 200, Set-Cookie y sin token en el body', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('ok');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'SOCIO' });
      userId = u.id;

      const res = await postLogin(app, { email, password: PASSWORD });
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('sesion=');
      expect(setCookie).toContain('HttpOnly');

      const cuerpo = await res.json();
      expect(cuerpo).toMatchObject({ id: u.id, rol: 'SOCIO' });
      expect(cuerpo).not.toHaveProperty('token'); // el token viaja SOLO en la cookie

      const token = leerTokenCookie(setCookie);
      expect(token).toBeTruthy();
      const resuelta = await resolverSesion(sql, token!);
      expect(resuelta?.actor).toEqual({ id: u.id, rol: 'SOCIO' });
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('contraseña incorrecta → 401 genérico y sin Set-Cookie', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('badpass');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const res = await postLogin(app, { email, password: 'incorrecta-xxxxx' });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('email inexistente → MISMO error que contraseña incorrecta (401)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await postLogin(app, { email: emailUnico('nope'), password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('crea sesión nueva e invalida la previa de la cookie', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const email = emailUnico('rotate');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ADMIN' });
      userId = u.id;
      const previa = await crearSesion(sql, u.id);

      const res = await postLogin(app, { email, password: PASSWORD }, `sesion=${previa.token}`);
      expect(res.status).toBe(200);

      // La sesión previa queda invalidada.
      expect(await resolverSesion(sql, previa.token)).toBeNull();
      // La nueva funciona.
      const nuevo = leerTokenCookie(res.headers.get('set-cookie') ?? '');
      expect(await resolverSesion(sql, nuevo!)).not.toBeNull();
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('body inválido (sin password) → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await postLogin(app, { email: 'a@b.com' });
      expect(res.status).toBe(400);
    } finally {
      await sql.end();
    }
  });
});

describe('controller/login — anti-enumeración por tiempos', () => {
  it.runIf(hasDb)('el email inexistente también ejecuta Argon2 (hash señuelo)', async () => {
    const sql = createDb();
    const email = emailUnico('timing');
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email, password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;

      const medir = async (fn: () => Promise<unknown>) => {
        const t0 = performance.now();
        await fn();
        return performance.now() - t0;
      };

      const tAusente = await medir(() => autenticar(sql, emailUnico('ghost'), PASSWORD));
      const tMalPass = await medir(() => autenticar(sql, email, 'incorrecta-xxxxx'));

      // Si el email inexistente hiciera short-circuit, tardaría <1ms. El señuelo
      // garantiza que ambos caminos ejecutan Argon2 (coste comparable).
      expect(tAusente).toBeGreaterThan(10);
      expect(tMalPass).toBeGreaterThan(10);
      const ratio = tAusente / tMalPass;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(2.5);
    } finally {
      if (userId) await limpiar(sql, userId);
      await sql.end();
    }
  });
});
