import type { Sql, ISql } from 'postgres';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError } from './errors.js';

export interface Project {
  id: string;
  student_id: string;
  titulo: string;
  descripcion: string | null;
  url: string;
  thumbnail_url: string | null;
  created_at: string;
}

export interface DatosNuevoProyecto {
  titulo: string;
  url: string;
  descripcion?: string | null;
  thumbnail_url?: string | null;
}

export interface CambiosProyecto {
  titulo?: string;
  url?: string;
  descripcion?: string | null;
  thumbnail_url?: string | null;
}

const PROY = (sql: ISql) => sql`
  id, student_id, titulo, descripcion, url, thumbnail_url, created_at::text as created_at
`;

/** Valida que `url` sea una URL http(s) bien formada (repo/web). */
export function validarUrl(url: unknown): void {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new DatosInvalidosError('La URL es obligatoria.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatosInvalidosError('URL no válida.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DatosInvalidosError('La URL debe ser http o https.');
  }
}

/**
 * Crea un proyecto para el alumno dueño (`userId`). Valida la URL y audita el
 * INSERT. La miniatura (`thumbnail_url`) es una subida manual (1ª iteración).
 * @returns el proyecto, o `null` si el usuario no tiene ficha de alumno.
 */
export async function crearProyecto(
  sql: Sql,
  userId: string,
  datos: DatosNuevoProyecto,
  idActor: string | null,
): Promise<Project | null> {
  const titulo = datos.titulo.trim();
  if (titulo.length === 0) throw new DatosInvalidosError('El título es obligatorio.');
  validarUrl(datos.url);

  const resultado = await sql.begin(async (tx) => {
    const st = await tx<{ id: string }[]>`select id from "Student" where user_id = ${userId}`;
    const student = st[0];
    if (!student) return null;

    const filas = await tx<Project[]>`
      insert into "Project" (student_id, titulo, descripcion, url, thumbnail_url)
      values (${student.id}, ${titulo}, ${datos.descripcion ?? null}, ${datos.url}, ${datos.thumbnail_url ?? null})
      returning ${PROY(tx)}
    `;
    const proyecto = filas[0]!;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Project',
      idRegistro: proyecto.id,
      operacion: 'INSERT',
      datosNuevos: { student_id: proyecto.student_id, titulo: proyecto.titulo, url: proyecto.url },
    });
    return proyecto;
  });
  return (resultado as Project | null) ?? null;
}

/** Lista los proyectos del alumno dueño (`userId`). */
export async function listarProyectosPorUserId(sql: Sql, userId: string): Promise<Project[]> {
  return sql<Project[]>`
    select ${PROY(sql)} from "Project" p
    where p.student_id = (select id from "Student" where user_id = ${userId})
    order by created_at desc
  `;
}

/**
 * Actualiza un proyecto propio del alumno (solo campos presentes). Valida la URL
 * si se cambia y audita el diff.
 * @returns el proyecto actualizado, o `null` si no existe o no es del alumno.
 */
export async function actualizarProyecto(
  sql: Sql,
  userId: string,
  projectId: string,
  cambios: CambiosProyecto,
  idActor: string | null,
): Promise<Project | null> {
  if (cambios.url !== undefined) validarUrl(cambios.url);
  if (cambios.titulo !== undefined && cambios.titulo.trim() === '') {
    throw new DatosInvalidosError('El título no puede estar vacío.');
  }

  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<Project[]>`
      select ${PROY(tx)} from "Project" p
      where p.id = ${projectId}
        and p.student_id = (select id from "Student" where user_id = ${userId})
      for update
    `;
    const previa = previas[0];
    if (!previa) return null;

    const tiene = (k: keyof CambiosProyecto) => Object.prototype.hasOwnProperty.call(cambios, k);
    const titulo = tiene('titulo') ? (cambios.titulo as string) : previa.titulo;
    const descripcion = tiene('descripcion') ? (cambios.descripcion ?? null) : previa.descripcion;
    const url = tiene('url') ? (cambios.url as string) : previa.url;
    const thumbnail_url = tiene('thumbnail_url') ? (cambios.thumbnail_url ?? null) : previa.thumbnail_url;

    const filas = await tx<Project[]>`
      update "Project" set titulo = ${titulo}, descripcion = ${descripcion}, url = ${url}, thumbnail_url = ${thumbnail_url}
      where id = ${projectId}
      returning ${PROY(tx)}
    `;
    const actualizado = filas[0]!;

    const claves = Object.keys(cambios) as (keyof CambiosProyecto)[];
    const datosAnteriores: Record<string, unknown> = {};
    const datosNuevos: Record<string, unknown> = {};
    for (const k of claves) {
      datosAnteriores[k] = (previa as unknown as Record<string, unknown>)[k];
      datosNuevos[k] = (actualizado as unknown as Record<string, unknown>)[k];
    }
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Project',
      idRegistro: projectId,
      operacion: 'UPDATE',
      datosAnteriores,
      datosNuevos,
    });
    return actualizado;
  });
  return (resultado as Project | null) ?? null;
}

/**
 * Borra un proyecto propio del alumno y audita el DELETE.
 * @returns `true` si se borró; `false` si no existe o no es del alumno.
 */
export async function borrarProyecto(
  sql: Sql,
  userId: string,
  projectId: string,
  idActor: string | null,
): Promise<boolean> {
  const borrado = await sql.begin(async (tx) => {
    const previas = await tx<{ id: string; student_id: string; titulo: string }[]>`
      select p.id, p.student_id, p.titulo from "Project" p
      where p.id = ${projectId}
        and p.student_id = (select id from "Student" where user_id = ${userId})
      for update
    `;
    const previa = previas[0];
    if (!previa) return false;

    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Project',
      idRegistro: previa.id,
      operacion: 'DELETE',
      datosAnteriores: { student_id: previa.student_id, titulo: previa.titulo },
    });
    await tx`delete from "Project" where id = ${previa.id}`;
    return true;
  });
  return borrado as boolean;
}
