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
import type { Edition } from '../../src/model/edition.js';
import {
  agruparEscaparate,
  listarEscaparate,
  obtenerEdicionEscaparate,
} from '../../src/model/escaparate.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t24-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

// --- Datos de referencia para las pruebas puras --------------------------------
const edicion = (id: string, nombre: string, anio: number): Edition => ({
  id,
  nombre,
  anio,
  fecha_inicio: null,
  fecha_fin: null,
  estado: 'cerrada',
});
const filaPublica = (
  id: string,
  editionId: string,
  nombre: string,
  extra: Partial<FilaPublica> = {},
): FilaPublica => ({
  id,
  edition_id: editionId,
  nombre,
  foto_url: 'https://cdn/foto.jpg',
  bio: 'Bio',
  ubicacion: 'Castellón',
  disponibilidad_traslado: true,
  modalidad: 'remoto',
  estado_laboral: 'buscando',
  cv_url: 'https://cdn/cv.pdf',
  linkedin: 'https://linkedin/x',
  github: 'https://github/x',
  privacy: {},
  ...extra,
});

describe('model/escaparate — agruparEscaparate (puro)', () => {
  it('agrupa cada alumno bajo su edición y conserva el orden de las ediciones', () => {
    const eds = [edicion('ed-2', 'Segunda', 2026), edicion('ed-1', 'Primera', 2025)];
    const filas = [
      filaPublica('al-a', 'ed-1', 'Ada'),
      filaPublica('al-b', 'ed-2', 'Linus'),
      filaPublica('al-c', 'ed-1', 'Grace'),
    ];
    const res = agruparEscaparate(eds, filas);
    expect(res.map((e) => e.id)).toEqual(['ed-2', 'ed-1']);
    expect(res[0]).toMatchObject({ id: 'ed-2', nombre: 'Segunda', anio: 2026 });
    expect(res[0]!.alumnos.map((a) => a.nombre)).toEqual(['Linus']);
    expect(res[1]!.alumnos.map((a) => a.nombre).sort()).toEqual(['Ada', 'Grace']);
  });

  it('una edición sin alumnos visibles aparece con alumnos: []', () => {
    const eds = [edicion('ed-1', 'Primera', 2025), edicion('ed-2', 'Vacía', 2026)];
    const filas = [filaPublica('al-a', 'ed-1', 'Ada')];
    const res = agruparEscaparate(eds, filas);
    expect(res[1]).toMatchObject({ id: 'ed-2', alumnos: [] });
  });

  it('aplica la privacidad por campo en cada card (campo privado ausente)', () => {
    const eds = [edicion('ed-1', 'Primera', 2025)];
    const filas = [filaPublica('al-a', 'ed-1', 'Ada', { privacy: { linkedin: false } })];
    const res = agruparEscaparate(eds, filas);
    const card = res[0]!.alumnos[0]!;
    expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
    expect(card.github).toBe('https://github/x');
    // La identidad nunca se oculta.
    expect(card.nombre).toBe('Ada');
    expect(card.edition_id).toBe('ed-1');
    // La proyección pública no expone privacy ni email.
    expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);
  });
});

describe('model/escaparate — listarEscaparate / obtenerEdicionEscaparate (enforcement, BD)', () => {
  it.runIf(hasDb)(
    'solo devuelve alumnos activos + consentidos; oculta inactivos y no-consentidos',
    async () => {
      const sql = createDb();
      const ed = await crearEdicion(sql, { nombre: 'EscEd', anio: 2026 }, null);
      // Alumno visible: activo + consentido.
      const visible = await crearAlumno(
        sql,
        { email: emailUnico('vis'), password: PASSWORD, nombre: 'Visible', edition_id: ed.id },
        null,
      );
      // Alumno activo pero SIN consentir.
      const sinConsent = await crearAlumno(
        sql,
        { email: emailUnico('noc'), password: PASSWORD, nombre: 'SinConsent', edition_id: ed.id },
        null,
      );
      // Alumno consentido pero INACTIVO.
      const inactivo = await crearAlumno(
        sql,
        { email: emailUnico('ina'), password: PASSWORD, nombre: 'Inactivo', edition_id: ed.id },
        null,
      );
      try {
        await cambiarEstadoPorUserId(sql, visible.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, visible.usuario.id, null);

        await cambiarEstadoPorUserId(sql, sinConsent.usuario.id, 'activo', null);

        await registrarConsentimiento(sql, inactivo.usuario.id, null); // consiente pero sigue inactivo

        const escaparate = await listarEscaparate(sql);
        const nuestra = escaparate.find((e) => e.id === ed.id)!;
        expect(nuestra.alumnos.map((a) => a.nombre)).toEqual(['Visible']);

        const soloEd = await obtenerEdicionEscaparate(sql, ed.id);
        expect(soloEd).not.toBeNull();
        expect(soloEd!.alumnos.map((a) => a.nombre)).toEqual(['Visible']);

        // Edición inexistente → null.
        expect(await obtenerEdicionEscaparate(sql, '00000000-0000-0000-0000-000000000000')).toBeNull();
      } finally {
        await borrarUsuario(sql, visible.usuario.id);
        await borrarUsuario(sql, sinConsent.usuario.id);
        await borrarUsuario(sql, inactivo.usuario.id);
        await borrarEdicion(sql, ed.id);
        await sql.end();
      }
    },
  );
});
