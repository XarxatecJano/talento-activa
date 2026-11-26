import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearEdicion } from '../../src/model/edition.js';
import { crearEmpresa, marcarSocia } from '../../src/model/company.js';
import {
  crearAlumno,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
  actualizarFicha,
} from '../../src/model/student.js';
import {
  proyectarAlumnoEnEmpresa,
  proyectarAlumnosEnEmpresas,
  asignarEmpresaActual,
  quitarEmpresaActual,
  listarAlumnosEnEmpresasSocias,
} from '../../src/model/empleo.js';
import type { FilaAlumnoEnEmpresa } from '../../src/model/empleo.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t29m-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

type Db = ReturnType<typeof createDb>;

function fila(over: Partial<FilaAlumnoEnEmpresa> = {}): FilaAlumnoEnEmpresa {
  return {
    id: 'st-1',
    edition_id: 'ed-1',
    nombre: 'Katherine',
    foto_url: null,
    bio: null,
    ubicacion: 'Castellón',
    disponibilidad_traslado: false,
    modalidad: 'remoto',
    estado_laboral: 'trabajando',
    cv_url: null,
    linkedin: 'https://linkedin/kj',
    github: null,
    privacy: {},
    empresa_id: 'co-1',
    empresa_nombre: 'Acme',
    ...over,
  };
}

describe('model/empleo — proyección (alumnos en empresas socias, T29)', () => {
  it('lista vacía → []', () => {
    expect(proyectarAlumnosEnEmpresas([])).toEqual([]);
  });

  it('proyecta la card pública + la empresa (id/nombre), sin email ni privacy', () => {
    const card = proyectarAlumnoEnEmpresa(fila());
    expect(card.id).toBe('st-1');
    expect(card.nombre).toBe('Katherine');
    expect(card.empresa).toEqual({ id: 'co-1', nombre: 'Acme' });
    expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(card, 'email')).toBe(false);
    // No filtra las columnas internas de la empresa.
    expect(Object.prototype.hasOwnProperty.call(card, 'empresa_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(card, 'empresa_nombre')).toBe(false);
  });

  it('aplica la privacidad por campo del alumno; la identidad y la empresa siempre van', () => {
    const card = proyectarAlumnoEnEmpresa(fila({ privacy: { linkedin: false, ubicacion: false } }));
    expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(card, 'ubicacion')).toBe(false);
    expect(card.id).toBe('st-1');
    expect(card.nombre).toBe('Katherine');
    expect(card.empresa).toEqual({ id: 'co-1', nombre: 'Acme' });
  });

  it('conserva el orden de entrada', () => {
    const cards = proyectarAlumnosEnEmpresas([
      fila({ id: 'a', nombre: 'Ana' }),
      fila({ id: 'b', nombre: 'Beto' }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

// --- Tests con BD (se omiten si no hay DATABASE_URL) --------------------------

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

describe('model/empleo — asignar/quitar current_company_id y sección (BD)', () => {
  it.runIf(hasDb)('asignar exige empresa socia y existente; audita; listar solo consultables en socia', async () => {
    const sql = createDb();
    const ed = await crearEdicion(sql, { nombre: 'EM', anio: 2026 }, null);
    const { company: socia } = await crearEmpresa(
      sql,
      { nombre: 'Socia', email: emailUnico('so'), password: PASSWORD, es_socia: true },
      null,
    );
    const { company: noSocia } = await crearEmpresa(
      sql,
      { nombre: 'NoSocia', email: emailUnico('ns'), password: PASSWORD, es_socia: false },
      null,
    );
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    try {
      // Empresa no socia → rechazado.
      expect(await asignarEmpresaActual(sql, ana.student.id, noSocia.id, null)).toBe('sin-empresa');
      // Empresa inexistente → rechazado.
      expect(
        await asignarEmpresaActual(sql, ana.student.id, '00000000-0000-0000-0000-000000000000', null),
      ).toBe('sin-empresa');
      // Alumno inexistente → rechazado.
      expect(await asignarEmpresaActual(sql, '00000000-0000-0000-0000-000000000000', socia.id, null)).toBe(
        'sin-alumno',
      );
      // Asignación válida.
      expect(await asignarEmpresaActual(sql, ana.student.id, socia.id, null)).toBe('ok');
      // Auditoría del UPDATE de current_company_id.
      const audit = await sql<{ datos_nuevos: { current_company_id?: string } }[]>`
        select datos_nuevos from "Audit_log"
        where tabla = 'Student' and id_registro = ${ana.student.id} and operacion = 'UPDATE'
        order by timestamp desc limit 1
      `;
      expect(audit[0]?.datos_nuevos.current_company_id).toBe(socia.id);

      // La sección lista a Ana con su empresa.
      const lista = await listarAlumnosEnEmpresasSocias(sql);
      const encontrada = lista.find((a) => a.id === ana.student.id);
      expect(encontrada?.empresa).toEqual({ id: socia.id, nombre: 'Socia' });

      // Quitar → desaparece de la sección.
      expect(await quitarEmpresaActual(sql, ana.student.id, null)).toBe(true);
      const lista2 = await listarAlumnosEnEmpresasSocias(sql);
      expect(lista2.find((a) => a.id === ana.student.id)).toBeUndefined();
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarEmpresa(sql, socia.id);
      await borrarEmpresa(sql, noSocia.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('un alumno no consultable asignado a socia NO aparece en la sección', async () => {
    const sql = createDb();
    const ed = await crearEdicion(sql, { nombre: 'EM2', anio: 2026 }, null);
    const { company: socia } = await crearEmpresa(
      sql,
      { nombre: 'Socia2', email: emailUnico('so'), password: PASSWORD, es_socia: true },
      null,
    );
    // Activo pero SIN consentimiento.
    const sinConsent = await crearAlumno(
      sql,
      { email: emailUnico('nc'), password: PASSWORD, nombre: 'SinConsent', edition_id: ed.id },
      null,
    );
    await cambiarEstadoPorUserId(sql, sinConsent.usuario.id, 'activo', null);
    try {
      expect(await asignarEmpresaActual(sql, sinConsent.student.id, socia.id, null)).toBe('ok');
      const lista = await listarAlumnosEnEmpresasSocias(sql);
      expect(lista.find((a) => a.id === sinConsent.student.id)).toBeUndefined();
    } finally {
      await borrarUsuario(sql, sinConsent.usuario.id);
      await borrarEmpresa(sql, socia.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('la sección respeta la privacidad por campo del alumno', async () => {
    const sql = createDb();
    const ed = await crearEdicion(sql, { nombre: 'EM3', anio: 2026 }, null);
    const { company: socia } = await crearEmpresa(
      sql,
      { nombre: 'Socia3', email: emailUnico('so'), password: PASSWORD, es_socia: true },
      null,
    );
    const ana = await alumnoVisible(sql, ed.id, 'Ana');
    await actualizarFicha(sql, ana.usuario.id, { linkedin: 'https://lk/ana', privacy: { linkedin: false } }, null);
    try {
      await asignarEmpresaActual(sql, ana.student.id, socia.id, null);
      const lista = await listarAlumnosEnEmpresasSocias(sql);
      const card = lista.find((a) => a.id === ana.student.id)!;
      expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
      expect(card.empresa.nombre).toBe('Socia3');
    } finally {
      await borrarUsuario(sql, ana.usuario.id);
      await borrarEmpresa(sql, socia.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });

  it.runIf(hasDb)('quitar en un alumno inexistente → false', async () => {
    const sql = createDb();
    try {
      expect(await quitarEmpresaActual(sql, '00000000-0000-0000-0000-000000000000', null)).toBe(false);
    } finally {
      await sql.end();
    }
  });
});
