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

/**
 * Forma de `Student.privacy` (jsonb): visibilidad **por campo**. Un campo es
 * visible por defecto; solo se oculta de la proyección pública si su entrada es
 * exactamente `false` (ver `campoVisible`). Se admite cualquier jsonb por
 * compatibilidad; los valores que no sean `false` no ocultan.
 */
export type Privacy = Record<string, unknown>;

/**
 * Campos de la proyección pública sujetos a privacidad por campo. La identidad
 * (`id`, `edition_id`, `nombre`) siempre es visible: una card del escaparate
 * necesita al menos identificar al alumno.
 */
export const CAMPOS_PRIVABLES = [
  'foto_url',
  'bio',
  'ubicacion',
  'disponibilidad_traslado',
  'modalidad',
  'estado_laboral',
  'cv_url',
  'linkedin',
  'github',
] as const;
export type CampoPrivable = (typeof CAMPOS_PRIVABLES)[number];

/**
 * Regla de visibilidad por campo: un campo es visible salvo que su entrada en
 * `privacy` sea exactamente el booleano `false`. Cualquier otro valor (ausente,
 * `true`, string heredado…) se considera visible.
 */
export function campoVisible(privacy: Privacy | null | undefined, campo: string): boolean {
  return !privacy || privacy[campo] !== false;
}

/** Proyección pública de un alumno para empresas (sin email ni privacy). Los
 * campos sujetos a privacidad son opcionales: se omiten si están marcados como
 * privados. */
export interface AlumnoPublico {
  id: string;
  edition_id: string;
  nombre: string;
  foto_url?: string | null;
  bio?: string | null;
  ubicacion?: string | null;
  disponibilidad_traslado?: boolean;
  modalidad?: Modalidad | null;
  estado_laboral?: EstadoLaboral | null;
  cv_url?: string | null;
  linkedin?: string | null;
  github?: string | null;
}

/** Fila completa relevante para la proyección pública (identidad + campos
 * privables + `privacy`). */
export interface FilaPublica {
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
  privacy: Privacy;
}

/**
 * Construye la proyección pública de un alumno aplicando la privacidad por campo:
 * la identidad siempre va; cada campo privable se incluye solo si es visible
 * (`privacy[campo] !== false`). Función pura y reutilizable por los listados del
 * escaparate (T24/T25/T27).
 */
export function proyectarAlumnoPublico(fila: FilaPublica): AlumnoPublico {
  const pub: AlumnoPublico = {
    id: fila.id,
    edition_id: fila.edition_id,
    nombre: fila.nombre,
  };
  const destino = pub as unknown as Record<string, unknown>;
  for (const campo of CAMPOS_PRIVABLES) {
    if (campoVisible(fila.privacy, campo)) {
      destino[campo] = (fila as unknown as Record<string, unknown>)[campo];
    }
  }
  return pub;
}

/**
 * Obtiene la proyección pública de un alumno para una empresa. Enforcement: solo
 * devuelve alumnos **activos** y **con consentimiento** (`consent_at` no nulo);
 * un alumno inactivo o sin consentir no es consultable (→ `null`). Aplica además
 * el **filtrado por campo** según `Student.privacy` (ver `proyectarAlumnoPublico`).
 */
export async function obtenerAlumnoPublico(sql: Sql, studentId: string): Promise<AlumnoPublico | null> {
  const filas = await sql<FilaPublica[]>`
    select id, edition_id, nombre, foto_url, bio, ubicacion, disponibilidad_traslado,
           modalidad, estado_laboral, cv_url, linkedin, github, privacy
    from "Student" where id = ${studentId} and estado = 'activo' and consent_at is not null
  `;
  const fila = filas[0];
  return fila ? proyectarAlumnoPublico(fila) : null;
}

/**
 * Proyección pública de un alumno con el **contacto** revelado (T27). Extiende la
 * card pública con el email de contacto, que solo está presente cuando el alumno
 * no lo marcó privado (`privacy.email !== false`). "Contacto por revelación": el
 * email se expone a la empresa según el consentimiento y la privacidad del alumno.
 */
export interface AlumnoPublicoConContacto extends AlumnoPublico {
  email?: string;
}

/**
 * Construye la proyección pública con contacto: la card pública (privacidad por
 * campo aplicada, ver `proyectarAlumnoPublico`) más el email, revelado solo si el
 * campo `email` es visible en `privacy` (`!== false`). Función pura y testable.
 */
export function proyectarAlumnoConContacto(
  fila: FilaPublica,
  email: string,
): AlumnoPublicoConContacto {
  const pub = proyectarAlumnoPublico(fila) as AlumnoPublicoConContacto;
  if (campoVisible(fila.privacy, 'email')) pub.email = email;
  return pub;
}

/**
 * Ficha pública completa de un alumno para una empresa, **con el email de
 * contacto** (T27). Enforcement idéntico a `obtenerAlumnoPublico`: solo alumnos
 * **activos** y **con consentimiento** son consultables (→ `null` en otro caso).
 * El email (de la tabla `User`) se incluye solo si el alumno no lo marcó privado
 * (`privacy.email !== false`); el resto de campos respeta la privacidad por campo.
 */
export async function obtenerAlumnoPublicoConContacto(
  sql: Sql,
  studentId: string,
): Promise<AlumnoPublicoConContacto | null> {
  const filas = await sql<(FilaPublica & { email: string })[]>`
    select s.id, s.edition_id, s.nombre, s.foto_url, s.bio, s.ubicacion,
           s.disponibilidad_traslado, s.modalidad, s.estado_laboral, s.cv_url,
           s.linkedin, s.github, s.privacy, u.email
    from "Student" s join "User" u on u.id = s.user_id
    where s.id = ${studentId} and s.estado = 'activo' and s.consent_at is not null
  `;
  const fila = filas[0];
  return fila ? proyectarAlumnoConContacto(fila, fila.email) : null;
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
