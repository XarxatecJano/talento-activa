import type { Sql, ISql } from 'postgres';
import { insertarUsuario } from './user.js';
import type { UsuarioPublico } from './user.js';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError, EmailYaRegistradoError } from './errors.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export type EstadoStudent = 'activo' | 'inactivo';

/** Proyección básica de un alumno (la ficha completa llega en T15). */
export interface Student {
  id: string;
  user_id: string;
  edition_id: string;
  nombre: string;
  estado: EstadoStudent;
}

export interface DatosNuevoAlumno {
  email: string;
  password: string;
  nombre: string;
  edition_id: string;
}

export type Modalidad = 'remoto' | 'presencial' | 'hibrido';
export type EstadoLaboral = 'buscando' | 'trabajando';

/** Ficha completa del alumno (proyección que ve su dueño). */
export interface FichaStudent {
  id: string;
  user_id: string;
  edition_id: string;
  current_company_id: string | null;
  nombre: string;
  foto_url: string | null;
  bio: string | null;
  ubicacion: string | null;
  disponibilidad_traslado: boolean;
  modalidad: Modalidad | null;
  estado_laboral: EstadoLaboral | null;
  cv_url: string | null;
  linkedin: string | null;
  github: string | null;
  consent_at: string | null;
  estado: EstadoStudent;
  privacy: Record<string, unknown>;
  filled_at: string | null;
  created_at: string;
}

/** Cambios admitidos al editar la ficha propia (todos opcionales). */
export interface CambiosFicha {
  nombre?: string;
  foto_url?: string | null;
  bio?: string | null;
  ubicacion?: string | null;
  disponibilidad_traslado?: boolean;
  modalidad?: Modalidad | null;
  estado_laboral?: EstadoLaboral | null;
  cv_url?: string | null;
  linkedin?: string | null;
  github?: string | null;
  privacy?: Record<string, unknown>;
}

const PROY_FICHA = (sql: ISql) => sql`
  id, user_id, edition_id, current_company_id, nombre, foto_url, bio, ubicacion,
  disponibilidad_traslado, modalidad, estado_laboral, cv_url, linkedin, github,
  consent_at::text as consent_at, estado, privacy,
  filled_at::text as filled_at, created_at::text as created_at
`;

/** Obtiene la ficha completa de un alumno por su user_id, o `null`. */
export async function obtenerFichaPorUserId(sql: Sql, userId: string): Promise<FichaStudent | null> {
  const filas = await sql<FichaStudent[]>`
    select ${PROY_FICHA(sql)} from "Student" where user_id = ${userId}
  `;
  return filas[0] ?? null;
}

/**
 * Actualiza la ficha propia del alumno (solo los campos presentes en `cambios`),
 * respetando la privacidad por campo (`privacy` jsonb), y audita el UPDATE con el
 * diff de los campos enviados.
 *
 * @returns la ficha actualizada, o `null` si el alumno no existe.
 */
export async function actualizarFicha(
  sql: Sql,
  userId: string,
  cambios: CambiosFicha,
  idActor: string | null,
): Promise<FichaStudent | null> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<FichaStudent[]>`
      select ${PROY_FICHA(tx)} from "Student" where user_id = ${userId} for update
    `;
    const previa = previas[0];
    if (!previa) return null;

    const tiene = <K extends keyof CambiosFicha>(k: K): boolean =>
      Object.prototype.hasOwnProperty.call(cambios, k);
    const elegir = <K extends keyof FichaStudent & keyof CambiosFicha>(k: K): FichaStudent[K] =>
      (tiene(k) ? (cambios[k] as FichaStudent[K]) : previa[k]);

    const privacy = tiene('privacy') ? (cambios.privacy as Record<string, unknown>) : previa.privacy;

    await tx`
      update "Student" set
        nombre = ${elegir('nombre')},
        foto_url = ${elegir('foto_url')},
        bio = ${elegir('bio')},
        ubicacion = ${elegir('ubicacion')},
        disponibilidad_traslado = ${elegir('disponibilidad_traslado')},
        modalidad = ${elegir('modalidad')},
        estado_laboral = ${elegir('estado_laboral')},
        cv_url = ${elegir('cv_url')},
        linkedin = ${elegir('linkedin')},
        github = ${elegir('github')},
        privacy = ${tx.json(privacy as Parameters<typeof tx.json>[0])}
      where user_id = ${userId}
    `;

    // Diff auditado: solo los campos enviados.
    const claves = Object.keys(cambios) as (keyof CambiosFicha)[];
    const datosAnteriores: Record<string, unknown> = {};
    const datosNuevos: Record<string, unknown> = {};
    for (const k of claves) {
      datosAnteriores[k] = (previa as unknown as Record<string, unknown>)[k];
      datosNuevos[k] = cambios[k];
    }
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: previa.id,
      operacion: 'UPDATE',
      datosAnteriores,
      datosNuevos,
    });

    const filas = await tx<FichaStudent[]>`
      select ${PROY_FICHA(tx)} from "Student" where user_id = ${userId}
    `;
    return filas[0]!;
  });
  return (resultado as FichaStudent | null) ?? null;
}

/**
 * Registra el consentimiento explícito del alumno para publicar sus datos (RGPD):
 * fija `consent_at` si aún no constaba y audita el cambio. Idempotente (conserva
 * la fecha del primer consentimiento). Sin consentimiento, el alumno no es
 * consultable por empresas (ver `obtenerAlumnoPublico`).
 *
 * @returns la ficha actualizada, o `null` si el alumno no existe.
 */
export async function registrarConsentimiento(
  sql: Sql,
  userId: string,
  idActor: string | null,
): Promise<FichaStudent | null> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<FichaStudent[]>`
      select ${PROY_FICHA(tx)} from "Student" where user_id = ${userId} for update
    `;
    const previa = previas[0];
    if (!previa) return null;
    if (previa.consent_at !== null) return previa; // ya consintió: idempotente.

    const filas = await tx<FichaStudent[]>`
      update "Student" set consent_at = now() where user_id = ${userId}
      returning ${PROY_FICHA(tx)}
    `;
    const actualizada = filas[0]!;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: previa.id,
      operacion: 'UPDATE',
      datosAnteriores: { consent_at: previa.consent_at },
      datosNuevos: { consent_at: actualizada.consent_at },
    });
    return actualizada;
  });
  return (resultado as FichaStudent | null) ?? null;
}

async function cambiarEstadoInterno(
  sql: Sql,
  columna: 'id' | 'user_id',
  valor: string,
  estado: EstadoStudent,
  idActor: string | null,
): Promise<Student | null> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<{ id: string; estado: EstadoStudent }[]>`
      select id, estado from "Student" where ${tx(columna)} = ${valor} for update
    `;
    const previa = previas[0];
    if (!previa) return null;

    const filas = await tx<Student[]>`
      update "Student" set estado = ${estado} where id = ${previa.id}
      returning id, user_id, edition_id, nombre, estado
    `;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: previa.id,
      operacion: 'UPDATE',
      datosAnteriores: { estado: previa.estado },
      datosNuevos: { estado },
    });
    return filas[0]!;
  });
  return (resultado as Student | null) ?? null;
}

/** Cambia el estado de un alumno por su user_id (uso: el propio alumno). */
export function cambiarEstadoPorUserId(
  sql: Sql,
  userId: string,
  estado: EstadoStudent,
  idActor: string | null,
): Promise<Student | null> {
  return cambiarEstadoInterno(sql, 'user_id', userId, estado, idActor);
}

/** Cambia el estado de un alumno por su id de Student (uso: admin). */
export function cambiarEstadoAlumno(
  sql: Sql,
  studentId: string,
  estado: EstadoStudent,
  idActor: string | null,
): Promise<Student | null> {
  return cambiarEstadoInterno(sql, 'id', studentId, estado, idActor);
}

async function borrarAlumnoInterno(
  sql: Sql,
  columna: 'id' | 'user_id',
  valor: string,
  idActor: string | null,
): Promise<boolean> {
  const borrado = await sql.begin(async (tx) => {
    const previas = await tx<{ id: string; user_id: string; nombre: string; edition_id: string; estado: EstadoStudent }[]>`
      select id, user_id, nombre, edition_id, estado from "Student"
      where ${tx(columna)} = ${valor} for update
    `;
    const previa = previas[0];
    if (!previa) return false;

    // Audita el borrado (snapshot sin datos sensibles) antes de eliminar.
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: previa.id,
      operacion: 'DELETE',
      datosAnteriores: { nombre: previa.nombre, edition_id: previa.edition_id, estado: previa.estado },
    });

    // Borrar el usuario arrastra en cascada Student y todos sus datos
    // (proyectos, skills, idiomas, bookmarks, Reminder_state, sesiones, tokens).
    await tx`delete from "User" where id = ${previa.user_id}`;
    return true;
  });
  return borrado as boolean;
}

/** Derecho al olvido: borra al alumno y todos sus datos por su user_id (uso: el propio alumno). */
export function borrarAlumnoPorUserId(sql: Sql, userId: string, idActor: string | null): Promise<boolean> {
  return borrarAlumnoInterno(sql, 'user_id', userId, idActor);
}

/** Derecho al olvido: borra al alumno y todos sus datos por su id de Student (uso: admin). */
export function borrarAlumnoPorId(sql: Sql, studentId: string, idActor: string | null): Promise<boolean> {
  return borrarAlumnoInterno(sql, 'id', studentId, idActor);
}

/** Proyección pública de un alumno para empresas (sin email ni privacy). */
export interface AlumnoPublico {
  id: string;
  edition_id: string;
  nombre: string;
  foto_url: string | null;
  bio: string | null;
  ubicacion: string | null;
  disponibilidad_traslado: boolean;
  modalidad: Modalidad | null;
  estado_laboral: EstadoLaboral | null;
  cv_url: string | null;
  linkedin: string | null;
  github: string | null;
}

/**
 * Obtiene la proyección pública de un alumno para una empresa. Enforcement: solo
 * devuelve alumnos **activos** y **con consentimiento** (`consent_at` no nulo);
 * un alumno inactivo o sin consentir no es consultable (→ `null`). El filtrado
 * fino por campo (`privacy`) llegará con el escaparate (fase 2).
 */
export async function obtenerAlumnoPublico(sql: Sql, studentId: string): Promise<AlumnoPublico | null> {
  const filas = await sql<AlumnoPublico[]>`
    select id, edition_id, nombre, foto_url, bio, ubicacion, disponibilidad_traslado,
           modalidad, estado_laboral, cv_url, linkedin, github
    from "Student" where id = ${studentId} and estado = 'activo' and consent_at is not null
  `;
  return filas[0] ?? null;
}

function codigo(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * Alta de un alumno finalizado: crea el usuario (rol ALUMNO) y su ficha Student
 * asociada a una edición, de forma atómica (una transacción), auditando ambos
 * INSERT. El Student nace 'inactivo' (no consultable por empresas hasta activar).
 *
 * @throws {DatosInvalidosError} datos inválidos o edición inexistente.
 * @throws {EmailYaRegistradoError} email ya registrado.
 */
export async function crearAlumno(
  sql: Sql,
  datos: DatosNuevoAlumno,
  idActor: string | null,
): Promise<{ usuario: UsuarioPublico; student: Student }> {
  const nombre = datos.nombre.trim();
  if (nombre.length === 0) throw new DatosInvalidosError('El nombre del alumno es obligatorio.');

  try {
    const resultado = await sql.begin(async (tx) => {
      const usuario = await insertarUsuario(
        tx,
        { email: datos.email, password: datos.password, rol: 'ALUMNO' },
        idActor,
      );
      const filas = await tx<Student[]>`
        insert into "Student" (user_id, edition_id, nombre)
        values (${usuario.id}, ${datos.edition_id}, ${nombre})
        returning id, user_id, edition_id, nombre, estado
      `;
      const student = filas[0]!;
      await registrarAuditoria(tx, {
        idUsuario: idActor,
        tabla: 'Student',
        idRegistro: student.id,
        operacion: 'INSERT',
        datosNuevos: {
          user_id: student.user_id,
          edition_id: student.edition_id,
          nombre: student.nombre,
          estado: student.estado,
        },
      });
      return { usuario, student };
    });
    return resultado as { usuario: UsuarioPublico; student: Student };
  } catch (err) {
    if (codigo(err) === UNIQUE_VIOLATION) throw new EmailYaRegistradoError();
    if (codigo(err) === FOREIGN_KEY_VIOLATION) {
      throw new DatosInvalidosError('La edición indicada no existe.');
    }
    throw err;
  }
}
