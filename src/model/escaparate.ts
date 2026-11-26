import type { Sql } from 'postgres';
import { proyectarAlumnoPublico } from './student.js';
import type { AlumnoPublico, FilaPublica } from './student.js';
import { listarEdiciones, obtenerEdicion } from './edition.js';
import type { Edition } from './edition.js';

/**
 * Edición del escaparate con sus alumnos **consultables** (cards). La proyección
 * de cada alumno es pública (sin email ni `privacy`) y respeta la privacidad por
 * campo. Solo se exponen datos identitarios de la edición (no su estado interno).
 */
export interface EdicionConAlumnos {
  id: string;
  nombre: string;
  anio: number;
  alumnos: AlumnoPublico[];
}

/**
 * Columnas de la proyección pública de un alumno (identidad + campos privables +
 * `privacy`), para el filtrado por campo en la capa de aplicación.
 */
const COLS_PUBLICAS = (sql: Sql) => sql`
  id, edition_id, nombre, foto_url, bio, ubicacion, disponibilidad_traslado,
  modalidad, estado_laboral, cv_url, linkedin, github, privacy
`;

/**
 * Agrupa las filas públicas (ya filtradas a **activos + consentidos**) bajo cada
 * edición y proyecta cada alumno aplicando la privacidad por campo. Función pura
 * y testable sin BD. Conserva el orden de `ediciones`; una edición sin alumnos
 * visibles aparece con `alumnos: []`.
 */
export function agruparEscaparate(ediciones: Edition[], filas: FilaPublica[]): EdicionConAlumnos[] {
  const porEdicion = new Map<string, AlumnoPublico[]>();
  for (const fila of filas) {
    const lista = porEdicion.get(fila.edition_id);
    const card = proyectarAlumnoPublico(fila);
    if (lista) lista.push(card);
    else porEdicion.set(fila.edition_id, [card]);
  }
  return ediciones.map((ed) => ({
    id: ed.id,
    nombre: ed.nombre,
    anio: ed.anio,
    alumnos: porEdicion.get(ed.id) ?? [],
  }));
}

/**
 * Escaparate completo: todas las ediciones con sus alumnos consultables
 * (activos + consentidos), proyección pública con privacidad por campo aplicada.
 * Los alumnos inactivos, sin consentimiento o con campos privados nunca se
 * exponen (enforcement en la capa de aplicación).
 */
export async function listarEscaparate(sql: Sql): Promise<EdicionConAlumnos[]> {
  const ediciones = await listarEdiciones(sql);
  const filas = await sql<FilaPublica[]>`
    select ${COLS_PUBLICAS(sql)} from "Student"
    where estado = 'activo' and consent_at is not null
    order by nombre
  `;
  return agruparEscaparate(ediciones, filas);
}

/**
 * Escaparate de una sola edición con sus alumnos consultables. Devuelve `null`
 * si la edición no existe.
 */
export async function obtenerEdicionEscaparate(
  sql: Sql,
  edicionId: string,
): Promise<EdicionConAlumnos | null> {
  const ed = await obtenerEdicion(sql, edicionId);
  if (!ed) return null;
  const filas = await sql<FilaPublica[]>`
    select ${COLS_PUBLICAS(sql)} from "Student"
    where edition_id = ${edicionId} and estado = 'activo' and consent_at is not null
    order by nombre
  `;
  return agruparEscaparate([ed], filas)[0]!;
}

/**
 * Campos públicos de un proyecto (sin `student_id`, que es interno). La miniatura
 * puede ser nula (subida manual, 1ª iteración).
 */
export interface ProyectoEscaparateBase {
  id: string;
  titulo: string;
  descripcion: string | null;
  url: string;
  thumbnail_url: string | null;
}

/**
 * Proyecto del escaparate: datos públicos del proyecto más la card pública de su
 * alumno dueño (proyección con privacidad por campo aplicada). El escaparate de
 * proyectos no tiene privacidad propia: un proyecto se expone **solo** si su
 * alumno dueño es consultable (activo + consentido).
 */
export interface ProyectoEscaparate extends ProyectoEscaparateBase {
  alumno: AlumnoPublico;
}

/**
 * Combina los campos públicos de un proyecto con la card pública de su alumno
 * dueño, aplicando la privacidad por campo del alumno (reutiliza
 * `proyectarAlumnoPublico`). Función pura y testable sin BD.
 */
export function proyectarProyectoEscaparate(
  proyecto: ProyectoEscaparateBase,
  alumno: FilaPublica,
): ProyectoEscaparate {
  return {
    id: proyecto.id,
    titulo: proyecto.titulo,
    descripcion: proyecto.descripcion,
    url: proyecto.url,
    thumbnail_url: proyecto.thumbnail_url,
    alumno: proyectarAlumnoPublico(alumno),
  };
}

/** Fila del join Project×Student para la proyección pública del escaparate. */
interface FilaProyectoPublica extends FilaPublica {
  proyecto_id: string;
  titulo: string;
  descripcion: string | null;
  url: string;
  thumbnail_url: string | null;
}

/**
 * Escaparate de proyectos: todos los proyectos cuyos alumnos dueños son
 * consultables (activos + consentidos), con la privacidad por campo del alumno
 * aplicada. Enforcement en SQL (join con `Student`); los proyectos de alumnos
 * inactivos o sin consentimiento nunca se exponen.
 */
export async function listarProyectosEscaparate(sql: Sql): Promise<ProyectoEscaparate[]> {
  const filas = await sql<FilaProyectoPublica[]>`
    select
      p.id as proyecto_id, p.titulo, p.descripcion, p.url, p.thumbnail_url,
      s.id, s.edition_id, s.nombre, s.foto_url, s.bio, s.ubicacion,
      s.disponibilidad_traslado, s.modalidad, s.estado_laboral, s.cv_url,
      s.linkedin, s.github, s.privacy
    from "Project" p
    join "Student" s on s.id = p.student_id
    where s.estado = 'activo' and s.consent_at is not null
    order by p.created_at desc
  `;
  return filas.map((f) =>
    proyectarProyectoEscaparate(
      {
        id: f.proyecto_id,
        titulo: f.titulo,
        descripcion: f.descripcion,
        url: f.url,
        thumbnail_url: f.thumbnail_url,
      },
      f,
    ),
  );
}
