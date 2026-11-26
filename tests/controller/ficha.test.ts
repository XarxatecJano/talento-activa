import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearAlumno } from '../../src/model/student.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t15-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

/** Crea un alumno verificado con sesión y ficha, en una edición. */
async function alumnoListo(sql: ReturnType<typeof createDb>) {
  const ed = await crearEdicion(sql, { nombre: 'FichaEd', anio: 2026 }, null);
  const { usuario, student } = await crearAlumno(
    sql,
    { email: emailUnico('al'), password: PASSWORD, nombre: 'Grace Hopper', edition_id: ed.id },
    null,
  );
  const { token } = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, token);
  const { token: cookieTok } = await crearSesion(sql, usuario.id);
  return { edId: ed.id, userId: usuario.id, studentId: student.id, cookie: `sesion=${cookieTok}` };
}

function req(app: ReturnType<typeof crearApp>, method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.request('/api/alumnos/me', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('controller/ficha — GET/PATCH /api/alumnos/me', () => {
  it.runIf(hasDb)('401 sin sesión; 403 si no es ALUMNO; 403 si ALUMNO sin verificar', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    let socioId: string | undefined;
    let edId: string | undefined;
    let alumnoUserId: string | undefined;
    try {
      expect((await req(app, 'GET')).status).toBe(401);

      // SOCIO verificado → 403 (rol)
      const socio = await crearUsuario(sql, { email: emailUnico('so'), password: PASSWORD, rol: 'SOCIO' });
      socioId = socio.id;
      const vt = await crearTokenVerificacion(sql, socio.id);
      await verificarEmail(sql, vt.token);
      const sSocio = await crearSesion(sql, socio.id);
      expect((await req(app, 'GET', `sesion=${sSocio.token}`)).status).toBe(403);

      // ALUMNO sin verificar → 403 (email no verificado)
      const ed = await crearEdicion(sql, { nombre: 'NV', anio: 2026 }, null);
      edId = ed.id;
      const { usuario } = await crearAlumno(sql, { email: emailUnico('nv'), password: PASSWORD, nombre: 'N', edition_id: ed.id }, null);
      alumnoUserId = usuario.id;
      const sNV = await crearSesion(sql, usuario.id);
      expect((await req(app, 'GET', `sesion=${sNV.token}`)).status).toBe(403);
    } finally {
      if (socioId) await borrarUsuario(sql, socioId);
      if (alumnoUserId) await borrarUsuario(sql, alumnoUserId);
      if (edId) await borrarEdicion(sql, edId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('GET devuelve la ficha propia completa (dueño ve todo)', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, cookie } = await alumnoListo(sql);
    try {
      const res = await req(app, 'GET', cookie);
      expect(res.status).toBe(200);
      const ficha = (await res.json()) as Record<string, unknown>;
      expect(ficha).toMatchObject({ user_id: userId, nombre: 'Grace Hopper', estado: 'inactivo' });
      expect(ficha.privacy).toEqual({});
    } finally {
      await borrarUsuario(sql, userId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('PATCH actualiza campos y privacy, persiste y audita', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, studentId, cookie } = await alumnoListo(sql);
    try {
      const res = await req(app, 'PATCH', cookie, {
        bio: 'Compiladora de compiladores',
        modalidad: 'remoto',
        github: 'https://github.com/grace',
        privacy: { linkedin: 'private', github: 'public' },
      });
      expect(res.status).toBe(200);
      const ficha = (await res.json()) as Record<string, unknown>;
      expect(ficha).toMatchObject({ bio: 'Compiladora de compiladores', modalidad: 'remoto', github: 'https://github.com/grace' });
      expect(ficha.privacy).toEqual({ linkedin: 'private', github: 'public' });

      const audit = await sql`select 1 from "Audit_log" where tabla = 'Student' and id_registro = ${studentId} and operacion = 'UPDATE'`;
      expect(audit).toHaveLength(1);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });

  it.runIf(hasDb)('PATCH con modalidad inválida → 400; sin campos editables → 400', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { edId, userId, cookie } = await alumnoListo(sql);
    try {
      expect((await req(app, 'PATCH', cookie, { modalidad: 'teletransporte' })).status).toBe(400);
      expect((await req(app, 'PATCH', cookie, { noexiste: 1 })).status).toBe(400);
    } finally {
      await borrarUsuario(sql, userId);
      await borrarEdicion(sql, edId);
      await sql.end();
    }
  });
});
