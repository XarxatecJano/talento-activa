import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearEdicion } from '../../src/model/edition.js';
import {
  crearAlumno,
  actualizarFicha,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
} from '../../src/model/student.js';
import type { FilaPublica } from '../../src/model/student.js';
import { crearItemCatalogo, asociarAlumno, SKILL_CFG } from '../../src/model/catalog.js';
import {
  filtrarAlumnosPublicos,
  listarAlumnosEscaparate,
} from '../../src/model/escaparate.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t26-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}
async function borrarSkill(sql: ReturnType<typeof createDb>, skillId: string) {
  await sql`delete from "Audit_log" where id_registro = ${skillId}`;
  await sql`delete from "Skill" where id = ${skillId}`;
}

// --- Datos de referencia para las pruebas puras --------------------------------
const filaPublica = (
  id: string,
  editionId: string,
  nombre: string,
  extra: Partial<FilaPublica> = {},
): FilaPublica => ({
  id,
  edition_id: editionId,
  nombre,
  foto_url: null,
  bio: null,
  ubicacion: null,
  disponibilidad_traslado: false,
  modalidad: 'remoto',
  estado_laboral: 'buscando',
  cv_url: null,
  linkedin: null,
  github: null,
  privacy: {},
  ...extra,
});

describe('model/escaparate — filtrarAlumnosPublicos (puro)', () => {
  const base = [
    filaPublica('a', 'ed-1', 'Ada', { modalidad: 'remoto', disponibilidad_traslado: true, estado_laboral: 'buscando' }),
    filaPublica('b', 'ed-1', 'Bob', { modalidad: 'presencial', disponibilidad_traslado: false, estado_laboral: 'trabajando' }),
    filaPublica('c', 'ed-2', 'Cey', { modalidad: 'remoto', disponibilidad_traslado: false, estado_laboral: 'buscando' }),
  ];

  it('sin filtros devuelve todas las filas', () => {
    expect(filtrarAlumnosPublicos(base, {}).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('filtra por edición', () => {
    expect(filtrarAlumnosPublicos(base, { edicion: 'ed-1' }).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('filtra por modalidad', () => {
    expect(filtrarAlumnosPublicos(base, { modalidad: 'remoto' }).map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('filtra por disponibilidad de traslado (true y false)', () => {
    expect(filtrarAlumnosPublicos(base, { disponibilidad: true }).map((f) => f.id)).toEqual(['a']);
    expect(filtrarAlumnosPublicos(base, { disponibilidad: false }).map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('filtra por estado laboral', () => {
    expect(filtrarAlumnosPublicos(base, { estado_laboral: 'trabajando' }).map((f) => f.id)).toEqual(['b']);
  });

  it('combina filtros con AND', () => {
    const r = filtrarAlumnosPublicos(base, { edicion: 'ed-1', modalidad: 'remoto', estado_laboral: 'buscando' });
    expect(r.map((f) => f.id)).toEqual(['a']);
  });

  it('un campo privado no se filtra: no revela un valor oculto (modalidad)', () => {
    // Cey tiene modalidad=remoto pero la marcó privada: NO debe aparecer al filtrar por remoto.
    const filas = [
      filaPublica('a', 'ed-1', 'Ada', { modalidad: 'remoto' }),
      filaPublica('c', 'ed-2', 'Cey', { modalidad: 'remoto', privacy: { modalidad: false } }),
    ];
    expect(filtrarAlumnosPublicos(filas, { modalidad: 'remoto' }).map((f) => f.id)).toEqual(['a']);
  });

  it('un campo privado no se filtra: disponibilidad y estado_laboral ocultos no matchean', () => {
    // Único candidato posible a cada filtro tiene el campo marcado privado → no casa.
    const filasDisp = [
      filaPublica('a', 'ed-1', 'Ada', { disponibilidad_traslado: true, privacy: { disponibilidad_traslado: false } }),
      filaPublica('b', 'ed-1', 'Bob', { disponibilidad_traslado: false }),
    ];
    expect(filtrarAlumnosPublicos(filasDisp, { disponibilidad: true })).toEqual([]);

    const filasEst = [
      filaPublica('a', 'ed-1', 'Ada', { estado_laboral: 'trabajando' }),
      filaPublica('b', 'ed-1', 'Bob', { estado_laboral: 'buscando', privacy: { estado_laboral: false } }),
    ];
    expect(filtrarAlumnosPublicos(filasEst, { estado_laboral: 'buscando' })).toEqual([]);
  });
});

describe('model/escaparate — listarAlumnosEscaparate (enforcement + skill, BD)', () => {
  it.runIf(hasDb)(
    'solo devuelve activos + consentidos y filtra por skill; aplica privacidad y proyección',
    async () => {
      const sql = createDb();
      const ed = await crearEdicion(sql, { nombre: 'T26Ed', anio: 2026 }, null);
      const skill = await crearItemCatalogo(sql, SKILL_CFG, `TypeScript-${Date.now()}`, null);

      // Alumno con la skill: activo + consentido.
      const conSkill = await crearAlumno(
        sql,
        { email: emailUnico('cs'), password: PASSWORD, nombre: 'ConSkill', edition_id: ed.id },
        null,
      );
      // Alumno sin la skill: activo + consentido.
      const sinSkill = await crearAlumno(
        sql,
        { email: emailUnico('ss'), password: PASSWORD, nombre: 'SinSkill', edition_id: ed.id },
        null,
      );
      // Alumno con la skill pero NO consentido (no consultable).
      const noConsent = await crearAlumno(
        sql,
        { email: emailUnico('nc'), password: PASSWORD, nombre: 'NoConsent', edition_id: ed.id },
        null,
      );
      try {
        await cambiarEstadoPorUserId(sql, conSkill.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, conSkill.usuario.id, null);
        await asociarAlumno(sql, SKILL_CFG, conSkill.usuario.id, skill.id, 'avanzado', null);
        await actualizarFicha(sql, conSkill.usuario.id, { linkedin: 'https://l/x', privacy: { linkedin: false } }, null);

        await cambiarEstadoPorUserId(sql, sinSkill.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, sinSkill.usuario.id, null);

        await cambiarEstadoPorUserId(sql, noConsent.usuario.id, 'activo', null);
        await asociarAlumno(sql, SKILL_CFG, noConsent.usuario.id, skill.id, 'medio', null);

        // Sin filtro: ambos consultables (conSkill, sinSkill), no el no-consentido.
        const todos = await listarAlumnosEscaparate(sql, { edicion: ed.id });
        expect(todos.map((a) => a.nombre).sort()).toEqual(['ConSkill', 'SinSkill']);

        // Filtrado por skill: solo el consultable que la tiene.
        const porSkill = await listarAlumnosEscaparate(sql, { edicion: ed.id, skill: skill.id });
        expect(porSkill.map((a) => a.nombre)).toEqual(['ConSkill']);
        const card = porSkill[0]!;
        // Proyección pública: campo privado ausente, sin privacy ni email.
        expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(card, 'email')).toBe(false);
      } finally {
        await borrarUsuario(sql, conSkill.usuario.id);
        await borrarUsuario(sql, sinSkill.usuario.id);
        await borrarUsuario(sql, noConsent.usuario.id);
        await borrarSkill(sql, skill.id);
        await borrarEdicion(sql, ed.id);
        await sql.end();
      }
    },
  );
});
