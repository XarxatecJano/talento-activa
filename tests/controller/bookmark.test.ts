import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearEmpresa } from '../../src/model/company.js';
import {
  crearAlumno,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
  actualizarFicha,
} from '../../src/model/student.js';
import { crearTokenVerificacion, verificarEmail } from '../../src/model/email_verification.js';
import { crearApp } from '../../src/controller/app.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t28-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

type Db = ReturnType<typeof createDb>;

async function borrarUsuario(sql: Db, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade: Student, Company_student_rel, etc.
}
async function borrarEmpresa(sql: Db, companyId: string) {
  await sql`delete from "Audit_log" where id_registro = ${companyId}`;
  await sql`delete from "Company" where id = ${companyId}`; // cascade: Company_user_rel, Company_student_rel
}
async function borrarEdicion(sql: Db, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

/** SOCIO verificado con empresa vinculada. */
async function socioConEmpresa(sql: Db, enviador: { enviarVerificacion(): Promise<void> }) {
  const { usuario, company } = await crearEmpresa(
    sql,
    { nombre: 'Acme', email: emailUnico('socio'), password: PASSWORD, es_socia: true },
    null,
  );
  const vt = await crearTokenVerificacion(sql, usuario.id);
  await verificarEmail(sql, vt.token);
  const { token } = await crearSesion(sql, usuario.id);
  return { socioId: usuario.id, companyId: company.id, cookie: `sesion=${token}` };
}

/** Alumno consultable (activo + consentido). */
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

function req(app: ReturnType<typeof crearApp>, path: string, method: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return app.request(path, { method, headers });
}

const enviadorNoop = { async enviarVerificacion() {} };

describe('controller/bookmark — T28 bookmarks de empresa (solo SOCIO verificado)', () => {
  it.runIf(hasDb)('permisos: 401 sin sesión, 403 ALUMNO/ADMIN en todas las rutas', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'BM', anio: 2026 }, null);
    const al = await alumnoVisible(sql, ed.id, 'Ana');
    const admin = await crearUsuario(sql, { email: emailUnico('ad'), password: PASSWORD, rol: 'ADMIN' });
    const { token: adminTok } = await crearSesion(sql, admin.id);
    // ALUMNO verificado (el propio alumno).
    const vt = await crearTokenVerificacion(sql, al.usuario.id);
    await verificarEmail(sql, vt.token);
    const { token: alTok } = await crearSesion(sql, al.usuario.id);
    try {
      for (const [method, path] of [
        ['GET', '/api/escaparate/bookmarks'],
        ['PUT', `/api/escaparate/bookmarks/${al.student.id}`],
        ['DELETE', `/api/escaparate/bookmarks/${al.student.id}`],
      ] as const) {
        expect((await req(app, path, method)).status).toBe(401);
        expect((await req(app, path, method, `sesion=${alTok}`)).status).toBe(403);
        expect((await req(app, path, method, `sesion=${adminTok}`)).status).toBe(403);
      }
    } finally {
      await borrarUsuario(sql, al.usuario.id);
      await borrarUsuario(sql, admin.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('guardar, listar, quitar — idempotentes y con privacidad aplicada', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'BM2', anio: 2026 }, null);
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    await actualizarFicha(sql, ana.usuario.id, { linkedin: 'https://lk/ana', privacy: { linkedin: false } }, null);
    const beto = await alumnoVisible(sql, ed.id, 'Beto');
    const socio = await socioConEmpresa(sql, enviadorNoop);
    try {
      // Vacío al principio.
      let res = await req(app, '/api/escaparate/bookmarks', 'GET', socio.cookie);
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown[]).toEqual([]);

      // Guardar Ana (204) e idempotente (204 de nuevo).
      expect((await req(app, `/api/escaparate/bookmarks/${ana.student.id}`, 'PUT', socio.cookie)).status).toBe(204);
      expect((await req(app, `/api/escaparate/bookmarks/${ana.student.id}`, 'PUT', socio.cookie)).status).toBe(204);
      // Guardar Beto.
      expect((await req(app, `/api/escaparate/bookmarks/${beto.student.id}`, 'PUT', socio.cookie)).status).toBe(204);

      // Listar: ambos, cards públicas con privacidad (linkedin de Ana oculto).
      res = await req(app, '/api/escaparate/bookmarks', 'GET', socio.cookie);
      const cards = (await res.json()) as { id: string; nombre: string; linkedin?: string }[];
      expect(new Set(cards.map((c) => c.nombre))).toEqual(new Set(['Ana', 'Beto']));
      const cardAna = cards.find((c) => c.nombre === 'Ana')!;
      expect(Object.prototype.hasOwnProperty.call(cardAna, 'linkedin')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cardAna, 'email')).toBe(false);

      // Quitar Beto (204) e idempotente (204).
      expect((await req(app, `/api/escaparate/bookmarks/${beto.student.id}`, 'DELETE', socio.cookie)).status).toBe(204);
      expect((await req(app, `/api/escaparate/bookmarks/${beto.student.id}`, 'DELETE', socio.cookie)).status).toBe(204);
      res = await req(app, '/api/escaparate/bookmarks', 'GET', socio.cookie);
      expect(((await res.json()) as { nombre: string }[]).map((c) => c.nombre)).toEqual(['Ana']);
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarUsuario(sql, beto.usuario.id);
      await borrarEmpresa(sql, socio.companyId);
      await borrarUsuario(sql, socio.socioId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('no se puede guardar un alumno no consultable (inactivo/sin consentir) → 404', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'BM3', anio: 2026 }, null);
    // Activo pero SIN consentimiento.
    const sinConsent = await crearAlumno(
      sql,
      { email: emailUnico('nc'), password: PASSWORD, nombre: 'SinConsent', edition_id: ed.id },
      null,
    );
    await cambiarEstadoPorUserId(sql, sinConsent.usuario.id, 'activo', null);
    const socio = await socioConEmpresa(sql, enviadorNoop);
    try {
      expect(
        (await req(app, `/api/escaparate/bookmarks/${sinConsent.student.id}`, 'PUT', socio.cookie)).status,
      ).toBe(404);
      // Inexistente → 404.
      expect(
        (await req(app, '/api/escaparate/bookmarks/00000000-0000-0000-0000-000000000000', 'PUT', socio.cookie)).status,
      ).toBe(404);
      // El listado sigue vacío.
      const res = await req(app, '/api/escaparate/bookmarks', 'GET', socio.cookie);
      expect((await res.json()) as unknown[]).toEqual([]);
    } finally {
      await borrarUsuario(sql, sinConsent.usuario.id);
      await borrarEmpresa(sql, socio.companyId);
      await borrarUsuario(sql, socio.socioId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('aislamiento por empresa: una empresa no ve ni borra los bookmarks de otra', async () => {
    const sql = createDb();
    const app = crearApp(sql, { enviador: enviadorNoop });
    const ed = await crearEdicion(sql, { nombre: 'BM4', anio: 2026 }, null);
    const al = await alumnoVisible(sql, ed.id, 'Compartida');
    const empA = await socioConEmpresa(sql, enviadorNoop);
    const empB = await socioConEmpresa(sql, enviadorNoop);
    try {
      // A guarda a la alumna.
      expect((await req(app, `/api/escaparate/bookmarks/${al.student.id}`, 'PUT', empA.cookie)).status).toBe(204);
      // B no la ve.
      let res = await req(app, '/api/escaparate/bookmarks', 'GET', empB.cookie);
      expect((await res.json()) as unknown[]).toEqual([]);
      // B intenta borrarla (idempotente, no afecta a A).
      expect((await req(app, `/api/escaparate/bookmarks/${al.student.id}`, 'DELETE', empB.cookie)).status).toBe(204);
      // A la sigue viendo.
      res = await req(app, '/api/escaparate/bookmarks', 'GET', empA.cookie);
      expect(((await res.json()) as { nombre: string }[]).map((c) => c.nombre)).toEqual(['Compartida']);
    } finally {
      await borrarUsuario(sql, al.usuario.id);
      await borrarEmpresa(sql, empA.companyId);
      await borrarUsuario(sql, empA.socioId);
      await borrarEmpresa(sql, empB.companyId);
      await borrarUsuario(sql, empB.socioId);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
