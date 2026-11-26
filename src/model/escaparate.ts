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
