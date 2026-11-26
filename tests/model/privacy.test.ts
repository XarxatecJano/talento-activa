import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearEdicion } from '../../src/model/edition.js';
import {
  crearAlumno,
  actualizarFicha,
  cambiarEstadoPorUserId,
  registrarConsentimiento,
  obtenerAlumnoPublico,
  campoVisible,
  proyectarAlumnoPublico,
  CAMPOS_PRIVABLES,
} from '../../src/model/student.js';

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) => `t23-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

async function borrarUsuario(sql: ReturnType<typeof createDb>, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`;
}
async function borrarEdicion(sql: ReturnType<typeof createDb>, edId: string) {
  await sql`delete from "Audit_log" where id_registro = ${edId}`;
  await sql`delete from "Edition" where id = ${edId}`;
}

// Fila completa de referencia para la proyección pública (todos los campos con valor).
const FILA = {
  id: 'id-1',
  edition_id: 'ed-1',
  nombre: 'Ada Lovelace',
  foto_url: 'https://cdn/foto.jpg',
  bio: 'Pionera',
  ubicacion: 'Londres',
  disponibilidad_traslado: true,
  modalidad: 'remoto' as const,
  estado_laboral: 'buscando' as const,
  cv_url: 'https://cdn/cv.pdf',
  linkedin: 'https://linkedin/ada',
  github: 'https://github/ada',
};

describe('model/privacy — campoVisible (regla: oculto solo si privacy[campo] === false)', () => {
  it('visible por defecto cuando no hay entrada o privacy es nulo/indefinido', () => {
    expect(campoVisible(undefined, 'linkedin')).toBe(true);
    expect(campoVisible(null, 'linkedin')).toBe(true);
    expect(campoVisible({}, 'linkedin')).toBe(true);
  });

  it('oculto solo con el valor booleano false; otros valores no ocultan', () => {
    expect(campoVisible({ linkedin: false }, 'linkedin')).toBe(false);
    expect(campoVisible({ linkedin: true }, 'linkedin')).toBe(true);
    // Valores que no son exactamente `false` no ocultan (p. ej. strings heredados).
    expect(campoVisible({ linkedin: 'private' }, 'linkedin')).toBe(true);
    expect(campoVisible({ linkedin: 0 }, 'linkedin')).toBe(true);
  });
});

describe('model/privacy — proyectarAlumnoPublico (filtrado por campo)', () => {
  it('sin privacy devuelve todos los campos públicos', () => {
    const pub = proyectarAlumnoPublico({ ...FILA, privacy: {} });
    expect(pub.id).toBe('id-1');
    expect(pub.edition_id).toBe('ed-1');
    expect(pub.nombre).toBe('Ada Lovelace');
    for (const campo of CAMPOS_PRIVABLES) {
      expect(Object.prototype.hasOwnProperty.call(pub, campo)).toBe(true);
    }
  });

  it('omite los campos marcados como privados; conserva el resto', () => {
    const pub = proyectarAlumnoPublico({
      ...FILA,
      privacy: { linkedin: false, bio: false },
    });
    expect(Object.prototype.hasOwnProperty.call(pub, 'linkedin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pub, 'bio')).toBe(false);
    // Los no marcados siguen presentes.
    expect(pub.github).toBe('https://github/ada');
    expect(pub.foto_url).toBe('https://cdn/foto.jpg');
  });

  it('la identidad (id, edition_id, nombre) nunca se oculta, aunque esté en privacy', () => {
    const pub = proyectarAlumnoPublico({
      ...FILA,
      privacy: { id: false, edition_id: false, nombre: false },
    });
    expect(pub.id).toBe('id-1');
    expect(pub.edition_id).toBe('ed-1');
    expect(pub.nombre).toBe('Ada Lovelace');
  });
});

describe('model/privacy — obtenerAlumnoPublico aplica la privacidad por campo', () => {
  it.runIf(hasDb)('un campo privado no aparece en la proyección pública', async () => {
    const sql = createDb();
    const ed = await crearEdicion(sql, { nombre: 'PrivEd', anio: 2026 }, null);
    const { usuario, student } = await crearAlumno(
      sql,
      { email: emailUnico('al'), password: PASSWORD, nombre: 'Katherine Johnson', edition_id: ed.id },
      null,
    );
    try {
      // Marca linkedin como privado, se activa y consiente → consultable.
      await actualizarFicha(sql, usuario.id, {
        linkedin: 'https://linkedin/kj',
        github: 'https://github/kj',
        privacy: { linkedin: false },
      }, usuario.id);
      await cambiarEstadoPorUserId(sql, usuario.id, 'activo', usuario.id);
      await registrarConsentimiento(sql, usuario.id, usuario.id);

      const pub = await obtenerAlumnoPublico(sql, student.id);
      expect(pub).not.toBeNull();
      // linkedin privado: ausente; github visible: presente.
      expect(Object.prototype.hasOwnProperty.call(pub, 'linkedin')).toBe(false);
      expect(pub!.github).toBe('https://github/kj');
      expect(pub!.nombre).toBe('Katherine Johnson');
    } finally {
      await borrarUsuario(sql, usuario.id);
      await borrarEdicion(sql, ed.id);
      await sql.end();
    }
  });
});
