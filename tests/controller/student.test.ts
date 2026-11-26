import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearApp } from '../../src/controller/app.js';
import type { EnviadorEmail } from '../../src/controller/email.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t13-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade: Student, tokens, sesiones
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
function post(app: ReturnType<typeof crearApp>, path: string, cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('controller/student — alta de alumnos finalizados (solo ADMIN)', () => {
  it.runIf(hasDb)('sin sesión → 401; no-admin → 403', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let userId: string | undefined;
    try {
      expect((await post(app, '/api/alumnos', undefined, {})).status).toBe(401);
      const u = await crearUsuario(sql, { email: emailUnico('a'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      expect((await post(app, '/api/alumnos', `sesion=${token}`, { email: emailUnico('x'), password: PASSWORD, nombre: 'N', edition_id: '00000000-0000-0000-0000-000000000000' })).status).toBe(403);
    } finally {
      if (userId) await borrarUsuario(sql, userId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('ADMIN crea alumno: User(ALUMNO)+Student inactivo, audita ambos y envía verificación', async () => {
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
    const ed = await crearEdicion(sql, { nombre: 'Promo 2026', anio: 2026 }, adminId);
    let alumnoUserId: string | undefined;
    try {
      const email = emailUnico('nuevo');
      const res = await post(app, '/api/alumnos', cookie, { email, password: PASSWORD, nombre: 'Ada Lovelace', edition_id: ed.id });
      expect(res.status).toBe(201);
      const cuerpo = (await res.json()) as {
        student: { id: string; estado: string; edition_id: string; nombre: string };
        usuario: { id: string; rol: string; email_verified: boolean };
      };
      alumnoUserId = cuerpo.usuario.id;

      expect(cuerpo.usuario.rol).toBe('ALUMNO');
      expect(cuerpo.usuario.email_verified).toBe(false);
      expect(cuerpo.student).toMatchObject({ estado: 'inactivo', edition_id: ed.id, nombre: 'Ada Lovelace' });

      const auditUser = await sql`select 1 from "Audit_log" where tabla = 'User' and id_registro = ${cuerpo.usuario.id} and operacion = 'INSERT'`;
      const auditStudent = await sql`select 1 from "Audit_log" where tabla = 'Student' and id_registro = ${cuerpo.student.id} and operacion = 'INSERT'`;
      expect(auditUser).toHaveLength(1);
      expect(auditStudent).toHaveLength(1);

      expect(capturado.destino).toBe(email);
      expect(capturado.token).toBeTruthy();
    } finally {
      if (alumnoUserId) await borrarUsuario(sql, alumnoUserId);
      await borrarEdicion(sql, ed.id);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('edición inexistente → 400 (nada queda creado)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    try {
      const email = emailUnico('noedi');
      const res = await post(app, '/api/alumnos', cookie, { email, password: PASSWORD, nombre: 'X', edition_id: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(400);
      // El usuario no debe haberse creado (atomicidad).
      const quedan = await sql`select 1 from "User" where lower(email) = lower(${email})`;
      expect(quedan).toHaveLength(0);
    } finally {
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('email duplicado → 409; body inválido → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    const ed = await crearEdicion(sql, { nombre: 'Dup', anio: 2026 }, adminId);
    let alumnoUserId: string | undefined;
    try {
      const email = emailUnico('dup');
      const primero = await post(app, '/api/alumnos', cookie, { email, password: PASSWORD, nombre: 'A', edition_id: ed.id });
      alumnoUserId = ((await primero.json()) as { usuario: { id: string } }).usuario.id;

      const dup = await post(app, '/api/alumnos', cookie, { email: email.toUpperCase(), password: PASSWORD, nombre: 'B', edition_id: ed.id });
      expect(dup.status).toBe(409);

      const malo = await post(app, '/api/alumnos', cookie, { email: emailUnico('m'), password: PASSWORD, nombre: '', edition_id: ed.id });
      expect(malo.status).toBe(400);
    } finally {
      if (alumnoUserId) await borrarUsuario(sql, alumnoUserId);
      await borrarEdicion(sql, ed.id);
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });
});
