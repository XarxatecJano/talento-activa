import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario, normalizarEmail } from '../../src/model/user.js';
import { DatosInvalidosError, EmailYaRegistradoError } from '../../src/model/errors.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

const PASSWORD_VALIDA = 'contraseña-segura-123';
const emailUnico = (p: string) => `t04-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

describe('model/user — normalizarEmail', () => {
  it('recorta espacios', () => {
    expect(normalizarEmail('  Ana@Ejemplo.com  ')).toBe('Ana@Ejemplo.com');
  });

  it('lanza DatosInvalidosError si está vacío o no tiene @', () => {
    expect(() => normalizarEmail('   ')).toThrow(DatosInvalidosError);
    expect(() => normalizarEmail('sinarroba')).toThrow(DatosInvalidosError);
  });
});

describe('model/user — crearUsuario (inserción real + auditoría)', () => {
  it.runIf(hasDb)('crea el usuario con email_verified=false y proyección sin hash', async () => {
    const sql = createDb();
    const email = emailUnico('ok');
    let id: string | undefined;
    try {
      const usuario = await crearUsuario(sql, { email, password: PASSWORD_VALIDA, rol: 'ALUMNO' });
      id = usuario.id;

      expect(usuario.email).toBe(email);
      expect(usuario.rol).toBe('ALUMNO');
      expect(usuario.email_verified).toBe(false);
      expect(usuario.created_at).toBeInstanceOf(Date);
      // La proyección pública NO expone el hash.
      expect('password_hash' in usuario).toBe(false);

      // Se ha escrito la auditoría del INSERT, sin datos sensibles.
      const audit = await sql<{ operacion: string; datos_nuevos: Record<string, unknown> }[]>`
        select operacion, datos_nuevos from "Audit_log"
        where tabla = 'User' and id_registro = ${usuario.id}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.operacion).toBe('INSERT');
      expect(audit[0]?.datos_nuevos).not.toHaveProperty('password_hash');
    } finally {
      if (id) {
        await sql`delete from "Audit_log" where id_registro = ${id}`;
        await sql`delete from "User" where id = ${id}`;
      }
      await sql.end();
    }
  });

  it.runIf(hasDb)('rechaza email duplicado (case-insensitive) con EmailYaRegistradoError', async () => {
    const sql = createDb();
    const base = emailUnico('dup');
    let id: string | undefined;
    try {
      const u = await crearUsuario(sql, { email: base.toLowerCase(), password: PASSWORD_VALIDA, rol: 'SOCIO' });
      id = u.id;
      await expect(
        crearUsuario(sql, { email: base.toUpperCase(), password: PASSWORD_VALIDA, rol: 'SOCIO' }),
      ).rejects.toBeInstanceOf(EmailYaRegistradoError);
    } finally {
      if (id) {
        await sql`delete from "Audit_log" where id_registro = ${id}`;
        await sql`delete from "User" where id = ${id}`;
      }
      await sql.end();
    }
  });

  it.runIf(hasDb)('propaga DatosInvalidosError si la password es demasiado corta', async () => {
    const sql = createDb();
    try {
      await expect(
        crearUsuario(sql, { email: emailUnico('short'), password: 'corta', rol: 'ALUMNO' }),
      ).rejects.toBeInstanceOf(DatosInvalidosError);
    } finally {
      await sql.end();
    }
  });
});
