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
import { crearProyecto } from '../../src/model/project.js';
import {
  proyectarProyectoEscaparate,
  listarProyectosEscaparate,
} from '../../src/model/escaparate.js';
import type { ProyectoEscaparateBase } from '../../src/model/escaparate.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t25-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
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
const proyectoBase = (id: string, extra: Partial<ProyectoEscaparateBase> = {}): ProyectoEscaparateBase => ({
  id,
  titulo: 'Mi proyecto',
  descripcion: 'Una descripción',
  url: 'https://github.com/x/repo',
  thumbnail_url: 'https://cdn/thumb.png',
  ...extra,
});

describe('model/escaparate — proyectarProyectoEscaparate (puro)', () => {
  it('combina los campos del proyecto con la card pública del alumno dueño', () => {
    const card = proyectarProyectoEscaparate(proyectoBase('p-1'), filaPublica('al-a', 'ed-1', 'Ada'));
    expect(card).toMatchObject({
      id: 'p-1',
      titulo: 'Mi proyecto',
      descripcion: 'Una descripción',
      url: 'https://github.com/x/repo',
      thumbnail_url: 'https://cdn/thumb.png',
    });
    // El autor va como proyección pública (identidad presente).
    expect(card.alumno).toMatchObject({ id: 'al-a', edition_id: 'ed-1', nombre: 'Ada' });
  });

  it('aplica la privacidad por campo del alumno dueño (campo privado ausente en el autor)', () => {
    const card = proyectarProyectoEscaparate(
      proyectoBase('p-1'),
      filaPublica('al-a', 'ed-1', 'Ada', { privacy: { linkedin: false } }),
    );
    expect(Object.prototype.hasOwnProperty.call(card.alumno, 'linkedin')).toBe(false);
    expect(card.alumno.github).toBe('https://github/x');
  });

  it('la card del autor no expone privacy ni email', () => {
    const card = proyectarProyectoEscaparate(proyectoBase('p-1'), filaPublica('al-a', 'ed-1', 'Ada'));
    expect(Object.prototype.hasOwnProperty.call(card.alumno, 'privacy')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(card.alumno, 'email')).toBe(false);
  });

  it('conserva la miniatura nula sin inventarla', () => {
    const card = proyectarProyectoEscaparate(proyectoBase('p-1', { thumbnail_url: null }), filaPublica('al-a', 'ed-1', 'Ada'));
    expect(card.thumbnail_url).toBeNull();
  });
});

describe('model/escaparate — listarProyectosEscaparate (enforcement, BD)', () => {
  it.runIf(hasDb)(
    'solo devuelve proyectos de alumnos activos + consentidos y aplica privacy del dueño',
    async () => {
      const sql = createDb();
      const ed = await crearEdicion(sql, { nombre: 'ProyEsc', anio: 2026 }, null);
      const visible = await crearAlumno(
        sql,
        { email: emailUnico('vis'), password: PASSWORD, nombre: 'Visible', edition_id: ed.id },
        null,
      );
      const sinConsent = await crearAlumno(
        sql,
        { email: emailUnico('noc'), password: PASSWORD, nombre: 'SinConsent', edition_id: ed.id },
        null,
      );
      const inactivo = await crearAlumno(
        sql,
        { email: emailUnico('ina'), password: PASSWORD, nombre: 'Inactivo', edition_id: ed.id },
        null,
      );
      try {
        // Visible: activo + consentido, con un campo privado.
        await actualizarFicha(sql, visible.usuario.id, { linkedin: 'https://linkedin/vis', privacy: { linkedin: false } }, null);
        await cambiarEstadoPorUserId(sql, visible.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, visible.usuario.id, null);
        await crearProyecto(sql, visible.usuario.id, { titulo: 'ProyVisible', url: 'https://github.com/a/b', thumbnail_url: 'https://cdn/t.png' }, null);

        // Activo pero sin consentir → su proyecto no aparece.
        await cambiarEstadoPorUserId(sql, sinConsent.usuario.id, 'activo', null);
        await crearProyecto(sql, sinConsent.usuario.id, { titulo: 'ProyNoConsent', url: 'https://github.com/c/d' }, null);

        // Consiente pero inactivo → su proyecto no aparece.
        await registrarConsentimiento(sql, inactivo.usuario.id, null);
        await crearProyecto(sql, inactivo.usuario.id, { titulo: 'ProyInactivo', url: 'https://github.com/e/f' }, null);

        const proyectos = await listarProyectosEscaparate(sql);
        const nuestros = proyectos.filter((p) => p.alumno.edition_id === ed.id);
        expect(nuestros.map((p) => p.titulo)).toEqual(['ProyVisible']);
        const card = nuestros[0]!;
        // Privacidad del dueño aplicada: linkedin oculto, identidad presente.
        expect(Object.prototype.hasOwnProperty.call(card.alumno, 'linkedin')).toBe(false);
        expect(card.alumno.nombre).toBe('Visible');
        expect(Object.prototype.hasOwnProperty.call(card.alumno, 'privacy')).toBe(false);
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
