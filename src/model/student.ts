import type { Sql } from 'postgres';
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
