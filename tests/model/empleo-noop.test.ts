import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearEmpresa } from '../../src/model/company.js';
import {
  crearAlumno,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
} from '../../src/model/student.js';
import { asignarEmpresaActual } from '../../src/model/empleo.js';

/**
 * MENOR 3 (revisión 2026-11-26): `asignarEmpresaActual` debe tratar la
 * reasignación de la MISMA empresa como un no-op idempotente —sin UPDATE ni
 * entrada de auditoría—, igual que `quitarEmpresaActual` hace con el `null`.
 * Reasignar la misma empresa no cambia el estado, así que no debe generar ruido
 * en `Audit_log` (un diff donde `datos_anteriores` y `datos_nuevos` coinciden).
 */

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) =>
  `t29-noop-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

type Db = ReturnType<typeof createDb>;

async function borrarUsuario(sql: Db, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEmpresa(sql: Db, companyId: string) {
  await sql`delete from "Audit_log" where id_registro = ${companyId}`;
  await sql`delete from "Company" where id = ${companyId}`;
}
async function borrarEdicion(sql: Db, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

async function alumnoVisible(sql: Db, edId: string, nombre: string) {
  const al = await crearAlumno(
    sql,
    { email: emailUnico('al'), password: PASSWORD, nombre, edition_id: edId },
    null,
  );
  await cambiarEstadoPorUserId(sql, al.usuario.id, 'activo', null);
  await registrarConsentimiento(sql, al.usuario.id, null);
  return al;
}

async function contarAuditUpdate(sql: Db, studentId: string): Promise<number> {
  const filas = await sql<{ n: string }[]>`
    select count(*)::text as n from "Audit_log"
    where tabla = 'Student' and id_registro = ${studentId} and operacion = 'UPDATE'
  `;
  return Number(filas[0]!.n);
}

describe('model/empleo — asignar la misma empresa es idempotente (MENOR 3, BD)', () => {
  it.runIf(hasDb)('reasignar la misma empresa devuelve ok sin UPDATE ni auditoría extra', async () => {
    const sql = createDb();
    const ed = await crearEdicion(sql, { nombre: 'EM-noop', anio: 2026 }, null);
    const { company: socia } = await crearEmpresa(
      sql,
      { nombre: 'SociaNoop', email: emailUnico('so'), password: PASSWORD, es_socia: true },
      null,
    );
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    try {
      // Primera asignación: cambia el estado y audita.
      expect(await asignarEmpresaActual(sql, ana.student.id, socia.id, null)).toBe('ok');
      const base = await contarAuditUpdate(sql, ana.student.id);

      // Reasignar la MISMA empresa: no-op idempotente, sigue 'ok' pero sin auditar.
      // El contador de UPDATE no debe crecer (delta 0).
      expect(await asignarEmpresaActual(sql, ana.student.id, socia.id, null)).toBe('ok');
      const tras2 = await contarAuditUpdate(sql, ana.student.id);
      expect(tras2).toBe(base);

      // El valor persistido sigue siendo la empresa asignada.
      const filas = await sql<{ current_company_id: string | null }[]>`
        select current_company_id from "Student" where id = ${ana.student.id}
      `;
      expect(filas[0]!.current_company_id).toBe(socia.id);
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarEmpresa(sql, socia.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
