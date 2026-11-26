import type { ISql } from 'postgres';

/**
 * Claves que NUNCA deben acabar en el log de auditoría (hash de contraseña ni
 * tokens en claro; ver invariantes de seguridad en CLAUDE.md). La comparación
 * es insensible a mayúsculas/minúsculas.
 */
export const CLAVES_SENSIBLES: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'token',
  'token_hash',
  'session_token',
]);

/**
 * Devuelve una copia de `datos` sin las claves sensibles, recorriendo objetos y
 * arrays de forma recursiva. No muta la entrada.
 */
export function sanitizarDatos(datos: unknown): unknown {
  if (Array.isArray(datos)) {
    return datos.map((item) => sanitizarDatos(item));
  }
  if (datos !== null && typeof datos === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, valor] of Object.entries(datos)) {
      if (CLAVES_SENSIBLES.has(clave.toLowerCase())) continue;
      salida[clave] = sanitizarDatos(valor);
    }
    return salida;
  }
  return datos;
}

export type Operacion = 'INSERT' | 'UPDATE' | 'DELETE';

export interface EntradaAuditoria {
  /** Usuario que origina la mutación; `null` si la genera el sistema. */
  idUsuario: string | null;
  /** Nombre de la tabla afectada. */
  tabla: string;
  /** PK del registro afectado (si aplica). */
  idRegistro?: string | null;
  operacion: Operacion;
  datosAnteriores?: Record<string, unknown> | null;
  datosNuevos?: Record<string, unknown> | null;
}

/**
 * Escribe una entrada en `Audit_log` desde la capa de aplicación. Sanea los
 * payloads antes de persistirlos para no filtrar datos sensibles.
 *
 * Acepta un `sql` que puede ser el cliente global o el handle de una
 * transacción, de modo que la auditoría se escriba en la misma transacción que
 * la mutación que la origina.
 *
 * @returns El id de la fila de auditoría insertada.
 */
export async function registrarAuditoria(sql: ISql, entrada: EntradaAuditoria): Promise<string> {
  // El resultado de sanitizarDatos es JSON-serializable por construcción.
  type ValorJson = Parameters<typeof sql.json>[0];
  const anteriores =
    entrada.datosAnteriores == null ? null : (sanitizarDatos(entrada.datosAnteriores) as ValorJson);
  const nuevos =
    entrada.datosNuevos == null ? null : (sanitizarDatos(entrada.datosNuevos) as ValorJson);

  const filas = await sql<{ id: string }[]>`
    insert into "Audit_log"
      (id_usuario, tabla, id_registro, operacion, datos_anteriores, datos_nuevos)
    values
      (${entrada.idUsuario}, ${entrada.tabla}, ${entrada.idRegistro ?? null}, ${entrada.operacion},
       ${anteriores === null ? null : sql.json(anteriores)},
       ${nuevos === null ? null : sql.json(nuevos)})
    returning id
  `;

  return filas[0]!.id;
}
