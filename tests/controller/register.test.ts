import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t10-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}

/** Crea un admin con sesión y devuelve su id + cookie. */
async function adminConSesion(sql: ReturnType<typeof createDb>) {
  const admin = await crearUsuario(sql, { email: emailUnico('admin'), password: PASSWORD, rol: 'ADMIN' });
  const { token } = await crearSesion(sql, admin.id);
  return { adminId: admin.id, cookie: `sesion=${token}` };
}

function postRegister(app: ReturnType<typeof crearApp>, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request('/api/auth/register', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('controller/register — POST /api/auth/register (solo ADMIN)', () => {
  it.runIf(hasDb)('sin sesión → 401', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    try {
      const res = await postRegister(app, { email: emailUnico('x'), password: PASSWORD, rol: 'ALUMNO' });
      expect(res.status).toBe(401);
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('sesión no-ADMIN → 403', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('alumno'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      const res = await postRegister(app, { email: emailUnico('x'), password: PASSWORD, rol: 'ALUMNO' }, `sesion=${token}`);
      expect(res.status).toBe(403);
    } finally {
      if (userId) await borrarUsuario(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('ADMIN crea usuario → 201, sin hash, email_verified=false y auditado con el admin', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await adminConSesion(sql);
    let nuevoId: string | undefined;
    try {
      const email = emailUnico('nuevo');
      const res = await postRegister(app, { email, password: PASSWORD, rol: 'SOCIO' }, cookie);
      expect(res.status).toBe(201);
      const cuerpo = (await res.json()) as {
        id: string;
        email: string;
        rol: string;
        email_verified: boolean;
      };
      nuevoId = cuerpo.id;
      expect(cuerpo).toMatchObject({ email, rol: 'SOCIO', email_verified: false });
      expect(cuerpo).not.toHaveProperty('password_hash');

      const audit = await sql<{ id_usuario: string | null; operacion: string }[]>`
        select id_usuario, operacion from "Audit_log" where tabla = 'User' and id_registro = ${cuerpo.id}
      `;
      expect(audit[0]?.operacion).toBe('INSERT');
      expect(audit[0]?.id_usuario).toBe(adminId); // alta por invitación del admin
    } finally {
      if (nuevoId) await borrarUsuario(sql, nuevoId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('email duplicado → 409 genérico', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await adminConSesion(sql);
    let nuevoId: string | undefined;
    try {
      const email = emailUnico('dup');
      const primero = await postRegister(app, { email, password: PASSWORD, rol: 'ALUMNO' }, cookie);
      nuevoId = ((await primero.json()) as { id: string }).id;

      const res = await postRegister(app, { email: email.toUpperCase(), password: PASSWORD, rol: 'ALUMNO' }, cookie);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('No se ha podido completar el registro');
    } finally {
      if (nuevoId) await borrarUsuario(sql, nuevoId);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('body inválido (rol desconocido o sin password) → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await adminConSesion(sql);
    try {
      const r1 = await postRegister(app, { email: emailUnico('r'), password: PASSWORD, rol: 'JEFE' }, cookie);
      expect(r1.status).toBe(400);
      const r2 = await postRegister(app, { email: emailUnico('r') }, cookie);
      expect(r2.status).toBe(400);
    } finally {
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });
});
