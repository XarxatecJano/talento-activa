import type { Sql } from 'postgres';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError, RecursoDuplicadoError } from './errors.js';

const UNIQUE_VIOLATION = '23505';

/** Configuración de un catálogo N:M (Skill o Language) y su tabla puente. */
export interface CatalogoConfig {
  tabla: 'Skill' | 'Language';
  rel: 'Skill_student_rel' | 'Language_student_rel';
  fk: 'skill_id' | 'language_id';
  niveles: readonly string[];
}

export const SKILL_CFG: CatalogoConfig = {
  tabla: 'Skill',
  rel: 'Skill_student_rel',
  fk: 'skill_id',
  niveles: ['basico', 'medio', 'avanzado'],
};

export const LANGUAGE_CFG: CatalogoConfig = {
  tabla: 'Language',
  rel: 'Language_student_rel',
  fk: 'language_id',
  niveles: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'nativo'],
};

export interface ItemCatalogo {
  id: string;
  nombre: string;
}

export interface ItemAlumno {
  id: string;
  nombre: string;
  nivel: string | null;
}

/** Resultado de asociar un item a un alumno. */
export type ResultadoAsociar = 'ok' | 'sin-alumno' | 'sin-item';

function esUnicidad(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/** Crea un item de catálogo (nombre único) y audita el INSERT. */
export async function crearItemCatalogo(
  sql: Sql,
  cfg: CatalogoConfig,
  nombre: string,
  idActor: string | null,
): Promise<ItemCatalogo> {
  const limpio = nombre.trim();
  if (limpio.length === 0) throw new DatosInvalidosError('El nombre es obligatorio.');
  try {
    const item = await sql.begin(async (tx) => {
      const filas = await tx<ItemCatalogo[]>`
        insert into ${tx(cfg.tabla)} (nombre) values (${limpio}) returning id, nombre
      `;
      const creado = filas[0]!;
      await registrarAuditoria(tx, {
        idUsuario: idActor,
        tabla: cfg.tabla,
        idRegistro: creado.id,
        operacion: 'INSERT',
        datosNuevos: { nombre: creado.nombre },
      });
      return creado;
    });
    return item as ItemCatalogo;
  } catch (err) {
    if (esUnicidad(err)) throw new RecursoDuplicadoError('El elemento ya existe');
    throw err;
  }
}

/** Lista el catálogo completo, por nombre. */
export async function listarCatalogo(sql: Sql, cfg: CatalogoConfig): Promise<ItemCatalogo[]> {
  return sql<ItemCatalogo[]>`select id, nombre from ${sql(cfg.tabla)} order by nombre`;
}

/**
 * Asocia (o actualiza el nivel de) un item de catálogo al alumno dueño. Upsert
 * sobre la tabla puente; audita el cambio.
 * @throws {DatosInvalidosError} si el nivel no es válido.
 */
export async function asociarAlumno(
  sql: Sql,
  cfg: CatalogoConfig,
  userId: string,
  itemId: string,
  nivel: string,
  idActor: string | null,
): Promise<ResultadoAsociar> {
  if (!cfg.niveles.includes(nivel)) throw new DatosInvalidosError('Nivel no válido.');

  const resultado = await sql.begin(async (tx): Promise<ResultadoAsociar> => {
    const st = await tx<{ id: string }[]>`select id from "Student" where user_id = ${userId}`;
    const student = st[0];
    if (!student) return 'sin-alumno';

    const existe = await tx`select 1 from ${tx(cfg.tabla)} where id = ${itemId}`;
    if (existe.length === 0) return 'sin-item';

    await tx`
      insert into ${tx(cfg.rel)} (${tx(cfg.fk)}, student_id, nivel)
      values (${itemId}, ${student.id}, ${nivel})
      on conflict (${tx(cfg.fk)}, student_id) do update set nivel = excluded.nivel
    `;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: cfg.rel,
      idRegistro: student.id,
      operacion: 'INSERT',
      datosNuevos: { [cfg.fk]: itemId, nivel },
    });
    return 'ok';
  });
  return resultado as ResultadoAsociar;
}

/**
 * Elimina la asociación de un item con el alumno dueño y audita.
 * @returns `true` si existía y se borró; `false` si no.
 */
export async function desasociarAlumno(
  sql: Sql,
  cfg: CatalogoConfig,
  userId: string,
  itemId: string,
  idActor: string | null,
): Promise<boolean> {
  const borrado = await sql.begin(async (tx) => {
    const st = await tx<{ id: string }[]>`select id from "Student" where user_id = ${userId}`;
    const student = st[0];
    if (!student) return false;

    const res = await tx`
      delete from ${tx(cfg.rel)} where ${tx(cfg.fk)} = ${itemId} and student_id = ${student.id}
    `;
    if (res.count === 0) return false;

    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: cfg.rel,
      idRegistro: student.id,
      operacion: 'DELETE',
      datosAnteriores: { [cfg.fk]: itemId },
    });
    return true;
  });
  return borrado as boolean;
}

/** Lista los items asociados al alumno dueño, con su nivel. */
export async function listarAsociacionesAlumno(
  sql: Sql,
  cfg: CatalogoConfig,
  userId: string,
): Promise<ItemAlumno[]> {
  return sql<ItemAlumno[]>`
    select c.id, c.nombre, r.nivel
    from ${sql(cfg.rel)} r
    join ${sql(cfg.tabla)} c on c.id = r.${sql(cfg.fk)}
    where r.student_id = (select id from "Student" where user_id = ${userId})
    order by c.nombre
  `;
}
