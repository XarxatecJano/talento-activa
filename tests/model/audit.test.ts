import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { registrarAuditoria, sanitizarDatos } from '../../src/model/audit.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');

describe('model/audit — sanitizarDatos (exclusiones)', () => {
  it('elimina password_hash y tokens, incluso anidados y en arrays', () => {
    const entrada = {
      email: 'ana@ejemplo.com',
      password_hash: '$argon2id$v=19$m=19456,t=2,p=1$...',
      perfil: { nombre: 'Ana', token: 'secreto-en-claro' },
      sesiones: [{ ip: '1.2.3.4', token_hash: 'abc123' }],
    };

    expect(sanitizarDatos(entrada)).toEqual({
      email: 'ana@ejemplo.com',
      perfil: { nombre: 'Ana' },
      sesiones: [{ ip: '1.2.3.4' }],
    });
  });

  it('ignora mayúsculas/minúsculas en las claves sensibles', () => {
    expect(sanitizarDatos({ Password_Hash: 'x', TOKEN: 'y', ok: 1 })).toEqual({ ok: 1 });
  });

  it('no muta la entrada original', () => {
    const entrada = { password_hash: 'x', ok: 1 };
    sanitizarDatos(entrada);
    expect(entrada).toEqual({ password_hash: 'x', ok: 1 });
  });

  it('conserva null y valores primitivos', () => {
    expect(sanitizarDatos(null)).toBeNull();
    expect(sanitizarDatos({ a: 1, b: null, c: 'txt' })).toEqual({ a: 1, b: null, c: 'txt' });
  });
});

describe('model/audit — registrarAuditoria (inserción real)', () => {
  it.runIf(hasDb)('inserta una fila y nunca persiste datos sensibles', async () => {
    const sql = createDb();
    try {
      const idRegistro = '00000000-0000-0000-0000-000000000001';
      const id = await registrarAuditoria(sql, {
        idUsuario: null, // null = generado por el sistema
        tabla: 'Test_audit',
        idRegistro,
        operacion: 'INSERT',
        datosNuevos: { email: 'x@y.com', password_hash: 'NO-DEBE-GUARDARSE' },
      });

      const rows = await sql<
        {
          id_usuario: string | null;
          tabla: string;
          id_registro: string | null;
          operacion: string;
          datos_anteriores: unknown;
          datos_nuevos: unknown;
          timestamp: Date;
        }[]
      >`
        select id_usuario, tabla, id_registro, operacion,
               datos_anteriores, datos_nuevos, "timestamp"
        from "Audit_log" where id = ${id}
      `;

      try {
        const row = rows[0];
        expect(row).toBeDefined();
        expect(row?.tabla).toBe('Test_audit');
        expect(row?.operacion).toBe('INSERT');
        expect(row?.id_usuario).toBeNull();
        expect(row?.id_registro).toBe(idRegistro);
        expect(row?.datos_anteriores).toBeNull();
        // password_hash NO debe estar en lo auditado.
        expect(row?.datos_nuevos).toEqual({ email: 'x@y.com' });
        expect(row?.timestamp).toBeInstanceOf(Date);
      } finally {
        await sql`delete from "Audit_log" where id = ${id}`;
      }
    } finally {
      await sql.end();
    }
  });
});
