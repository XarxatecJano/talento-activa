import type { Sql, ISql } from 'postgres';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError } from './errors.js';

export type EstadoEdicion = 'abierta' | 'cerrada';

export interface Edition {
  id: string;
  nombre: string;
  anio: number;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  estado: EstadoEdicion;
}

export interface DatosNuevaEdicion {
  nombre: string;
  anio: number;
  fecha_inicio?: string | null;
  fecha_fin?: string | null;
}

// Fechas como texto ('YYYY-MM-DD') para una proyección estable en la API.
const PROYECCION = (sql: ISql) => sql`
  id, nombre, anio, fecha_inicio::text, fecha_fin::text, estado
`;

/** Crea una edición (estado 'abierta') y audita el INSERT. */
export async function crearEdicion(
  sql: Sql,
  datos: DatosNuevaEdicion,
  idActor: string | null,
): Promise<Edition> {
  const nombre = datos.nombre.trim();
  if (nombre.length === 0) throw new DatosInvalidosError('El nombre de la edición es obligatorio.');
  if (!Number.isInteger(datos.anio)) throw new DatosInvalidosError('El año debe ser un entero.');

  const ed = await sql.begin(async (tx) => {
    const filas = await tx<Edition[]>`
      insert into "Edition" (nombre, anio, fecha_inicio, fecha_fin)
      values (${nombre}, ${datos.anio}, ${datos.fecha_inicio ?? null}, ${datos.fecha_fin ?? null})
      returning ${PROYECCION(tx)}
    `;
    const creada = filas[0]!;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Edition',
      idRegistro: creada.id,
      operacion: 'INSERT',
      datosNuevos: { ...creada },
    });
    return creada;
  });
  return ed as Edition;
}

/** Lista todas las ediciones (vista admin), de la más reciente a la más antigua. */
export async function listarEdiciones(sql: Sql): Promise<Edition[]> {
  return sql<Edition[]>`select ${PROYECCION(sql)} from "Edition" order by anio desc, nombre`;
}

/** Obtiene una edición por id, o `null`. */
export async function obtenerEdicion(sql: Sql, id: string): Promise<Edition | null> {
  const filas = await sql<Edition[]>`select ${PROYECCION(sql)} from "Edition" where id = ${id}`;
  return filas[0] ?? null;
}

/**
 * Cierra una edición (estado 'cerrada') y audita el UPDATE.
 * @returns la edición actualizada, o `null` si no existe.
 */
export async function cerrarEdicion(sql: Sql, id: string, idActor: string | null): Promise<Edition | null> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<Edition[]>`select ${PROYECCION(tx)} from "Edition" where id = ${id} for update`;
    const previa = previas[0];
    if (!previa) return null;

    const filas = await tx<Edition[]>`
      update "Edition" set estado = 'cerrada' where id = ${id}
      returning ${PROYECCION(tx)}
    `;
    const actualizada = filas[0]!;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Edition',
      idRegistro: id,
      operacion: 'UPDATE',
      datosAnteriores: { estado: previa.estado },
      datosNuevos: { estado: 'cerrada' },
    });
    return actualizada;
  });
  return (resultado as Edition | null) ?? null;
}
