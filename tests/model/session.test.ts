import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import {
  generarToken,
  hashToken,
  crearSesion,
  resolverSesion,
  eliminarSesionPorToken,
  DURACION_DIAS,
} from '../../src/model/session.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const DIA_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t05-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

describe('model/session — token opaco', () => {
  it('generarToken: 32 bytes en base64url (43 chars, alfabeto url-safe)', () => {
    const t = generarToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
  });

  it('generarToken: dos tokens distintos', () => {
    expect(generarToken()).not.toBe(generarToken());
  });

  it('hashToken: SHA-256 en hex (64 chars) y determinista', () => {
    const t = generarToken();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
  });
});

describe('model/session — crearSesion / resolverSesion (BD real)', () => {
  it.runIf(hasDb)('crea sesión guardando solo el SHA-256 y resuelve el Actor', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('ok'), password: PASSWORD, rol: 'SOCIO' });
      userId = u.id;

      const { token, expiresAt } = await crearSesion(sql, u.id);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DIA_MS);

      // En la tabla solo vive el hash, nunca el token en claro.
      const filas = await sql<{ token_sha256: string }[]>`
        select token_sha256 from "Session" where user_id = ${u.id}
      `;
      expect(filas).toHaveLength(1);
      expect(filas[0]?.token_sha256).toBe(hashToken(token));
      expect(filas[0]?.token_sha256).not.toBe(token);

      const res = await resolverSesion(sql, token);
      expect(res).not.toBeNull();
      expect(res?.actor).toEqual({ id: u.id, rol: 'SOCIO' });
      expect(res?.renovada).toBe(false);
    } finally {
      if (userId) {
        await sql`delete from "Audit_log" where id_registro = ${userId}`;
        await sql`delete from "User" where id = ${userId}`; // cascade borra Session
      }
      await sql.end();
    }
  });

  it.runIf(hasDb)('token inexistente → null', async () => {
    const sql = createDb();
    try {
      expect(await resolverSesion(sql, generarToken())).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it.runIf(hasDb)('sesión caducada → null y se borra la fila', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('exp'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      // Forzamos caducidad en el pasado.
      await sql`update "Session" set expires_at = ${new Date(Date.now() - DIA_MS)} where user_id = ${u.id}`;

      expect(await resolverSesion(sql, token)).toBeNull();
      const quedan = await sql`select 1 from "Session" where token_sha256 = ${hashToken(token)}`;
      expect(quedan).toHaveLength(0);
    } finally {
      if (userId) {
        await sql`delete from "Audit_log" where id_registro = ${userId}`;
        await sql`delete from "User" where id = ${userId}`;
      }
      await sql.end();
    }
  });

  it.runIf(hasDb)('renovación deslizante: <15 días restantes → extiende a 30 y renovada=true', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('renew'), password: PASSWORD, rol: 'ALUMNO' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);
      // Quedan 10 días (< umbral de 15).
      await sql`update "Session" set expires_at = ${new Date(Date.now() + 10 * DIA_MS)} where user_id = ${u.id}`;

      const res = await resolverSesion(sql, token);
      expect(res?.renovada).toBe(true);
      expect(res?.expiresAt.getTime()).toBeGreaterThan(Date.now() + (DURACION_DIAS - 1) * DIA_MS);

      const fila = await sql<{ expires_at: Date }[]>`
        select expires_at from "Session" where user_id = ${u.id}
      `;
      expect(fila[0]?.expires_at.getTime()).toBeGreaterThan(Date.now() + (DURACION_DIAS - 1) * DIA_MS);
    } finally {
      if (userId) {
        await sql`delete from "Audit_log" where id_registro = ${userId}`;
        await sql`delete from "User" where id = ${userId}`;
      }
      await sql.end();
    }
  });

  it.runIf(hasDb)('eliminarSesionPorToken borra la sesión (idempotente)', async () => {
    const sql = createDb();
    let userId: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: emailUnico('del'), password: PASSWORD, rol: 'ADMIN' });
      userId = u.id;
      const { token } = await crearSesion(sql, u.id);

      expect(await eliminarSesionPorToken(sql, token)).toBe(true);
      expect(await resolverSesion(sql, token)).toBeNull();
      // Segunda vez: no había fila, pero no lanza.
      expect(await eliminarSesionPorToken(sql, token)).toBe(false);
    } finally {
      if (userId) {
        await sql`delete from "Audit_log" where id_registro = ${userId}`;
        await sql`delete from "User" where id = ${userId}`;
      }
      await sql.end();
    }
  });
});
