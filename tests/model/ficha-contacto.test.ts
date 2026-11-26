import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearEdicion } from '../../src/model/edition.js';
import {
  crearAlumno,
  actualizarFicha,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
  proyectarAlumnoConContacto,
  obtenerAlumnoPublicoConContacto,
} from '../../src/model/student.js';
import type { FilaPublica } from '../../src/model/student.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t27-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

const filaPublica = (extra: Partial<FilaPublica> = {}): FilaPublica => ({
  id: 'al-1',
  edition_id: 'ed-1',
  nombre: 'Ada',
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

describe('model/student — proyectarAlumnoConContacto (puro, T27)', () => {
  it('revela el email cuando el alumno no lo marcó privado', () => {
    const card = proyectarAlumnoConContacto(filaPublica(), 'ada@correo.test');
    expect(card.email).toBe('ada@correo.test');
    // La identidad y los campos visibles siguen presentes.
    expect(card.nombre).toBe('Ada');
    expect(card.github).toBe('https://github/x');
  });

  it('oculta el email cuando privacy.email === false (contacto por revelación)', () => {
    const card = proyectarAlumnoConContacto(filaPublica({ privacy: { email: false } }), 'ada@correo.test');
    expect(Object.prototype.hasOwnProperty.call(card, 'email')).toBe(false);
  });

  it('aplica además la privacidad por campo del resto de la ficha', () => {
    const card = proyectarAlumnoConContacto(
      filaPublica({ privacy: { linkedin: false } }),
      'ada@correo.test',
    );
    // Email visible, linkedin oculto.
    expect(card.email).toBe('ada@correo.test');
    expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
    // La proyección no expone privacy.
    expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);
  });

  it('un valor de privacy distinto de false no oculta el email', () => {
    const card = proyectarAlumnoConContacto(filaPublica({ privacy: { email: true } }), 'ada@correo.test');
    expect(card.email).toBe('ada@correo.test');
  });
});

describe('model/student — obtenerAlumnoPublicoConContacto (enforcement, BD, T27)', () => {
  it.runIf(hasDb)(
    'devuelve la ficha pública con email solo para alumnos consultables; null si no',
    async () => {
      const sql = createDb();
      const ed = await crearEdicion(sql, { nombre: 'T27Ed', anio: 2026 }, null);

      const emailVisible = emailUnico('vis');
      const visible = await crearAlumno(
        sql,
        { email: emailVisible, password: PASSWORD, nombre: 'Visible', edition_id: ed.id },
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
      const emailPrivado = emailUnico('prv');
      const conEmailPrivado = await crearAlumno(
        sql,
        { email: emailPrivado, password: PASSWORD, nombre: 'Reservado', edition_id: ed.id },
        null,
      );
      try {
        // Consultable: activo + consentido, email no privado.
        await cambiarEstadoPorUserId(sql, visible.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, visible.usuario.id, null);

        // Activo pero sin consentir → no consultable.
        await cambiarEstadoPorUserId(sql, sinConsent.usuario.id, 'activo', null);

        // Consentido pero inactivo → no consultable.
        await registrarConsentimiento(sql, inactivo.usuario.id, null);

        // Consultable pero con el email marcado privado.
        await actualizarFicha(sql, conEmailPrivado.usuario.id, { privacy: { email: false } }, null);
        await cambiarEstadoPorUserId(sql, conEmailPrivado.usuario.id, 'activo', null);
        await registrarConsentimiento(sql, conEmailPrivado.usuario.id, null);

        const card = await obtenerAlumnoPublicoConContacto(sql, visible.student.id);
        expect(card).not.toBeNull();
        expect(card!.nombre).toBe('Visible');
        expect(card!.email).toBe(emailVisible);

        // No consultables → null.
        expect(await obtenerAlumnoPublicoConContacto(sql, sinConsent.student.id)).toBeNull();
        expect(await obtenerAlumnoPublicoConContacto(sql, inactivo.student.id)).toBeNull();

        // Consultable con email privado: ficha presente, email oculto.
        const reservado = await obtenerAlumnoPublicoConContacto(sql, conEmailPrivado.student.id);
        expect(reservado).not.toBeNull();
        expect(Object.prototype.hasOwnProperty.call(reservado, 'email')).toBe(false);

        // Id inexistente → null.
        expect(
          await obtenerAlumnoPublicoConContacto(sql, '00000000-0000-0000-0000-000000000000'),
        ).toBeNull();
      } finally {
        await borrarUsuario(sql, visible.usuario.id);
        await borrarUsuario(sql, sinConsent.usuario.id);
        await borrarUsuario(sql, inactivo.usuario.id);
        await borrarUsuario(sql, conEmailPrivado.usuario.id);
        await borrarEdicion(sql, ed.id);
        await sql.end();
      }
    },
  );
});
