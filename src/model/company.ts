import type { Sql, ISql } from 'postgres';
import { insertarUsuario } from './user.js';
import type { UsuarioPublico } from './user.js';
import { registrarAuditoria } from './audit.js';
import { DatosInvalidosError, EmailYaRegistradoError } from './errors.js';

const UNIQUE_VIOLATION = '23505';

export interface Company {
  id: string;
  nombre: string;
  es_socia: boolean;
  contacto: string | null;
}

export interface DatosNuevaEmpresa {
  nombre: string;
  /** Credenciales del usuario SOCIO que se invita para la empresa. */
  email: string;
  password: string;
  contacto?: string | null;
  es_socia?: boolean;
}

const PROYECCION = (sql: ISql) => sql`id, nombre, es_socia, contacto`;

function esUnicidad(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Alta de empresa por invitación: crea la Company, invita un usuario SOCIO y los
 * vincula en Company_user_rel, de forma atómica, auditando el INSERT de Company.
 * Envía la verificación aparte (controlador).
 *
 * @throws {DatosInvalidosError} nombre vacío o datos de usuario inválidos.
 * @throws {EmailYaRegistradoError} email ya registrado.
 */
export async function crearEmpresa(
  sql: Sql,
  datos: DatosNuevaEmpresa,
  idActor: string | null,
): Promise<{ usuario: UsuarioPublico; company: Company }> {
  const nombre = datos.nombre.trim();
  if (nombre.length === 0) throw new DatosInvalidosError('El nombre de la empresa es obligatorio.');

  try {
    const resultado = await sql.begin(async (tx) => {
      const usuario = await insertarUsuario(
        tx,
        { email: datos.email, password: datos.password, rol: 'SOCIO' },
        idActor,
      );
      const filas = await tx<Company[]>`
        insert into "Company" (nombre, es_socia, contacto, created_by)
        values (${nombre}, ${datos.es_socia ?? false}, ${datos.contacto ?? null}, ${idActor})
        returning ${PROYECCION(tx)}
      `;
      const company = filas[0]!;
      await tx`
        insert into "Company_user_rel" (company_id, user_id) values (${company.id}, ${usuario.id})
      `;
      await registrarAuditoria(tx, {
        idUsuario: idActor,
        tabla: 'Company',
        idRegistro: company.id,
        operacion: 'INSERT',
        datosNuevos: { nombre: company.nombre, es_socia: company.es_socia, contacto: company.contacto },
      });
      return { usuario, company };
    });
    return resultado as { usuario: UsuarioPublico; company: Company };
  } catch (err) {
    if (esUnicidad(err)) throw new EmailYaRegistradoError();
    throw err;
  }
}

/** Lista todas las empresas (vista admin). */
export async function listarEmpresas(sql: Sql): Promise<Company[]> {
  return sql<Company[]>`select ${PROYECCION(sql)} from "Company" order by nombre`;
}

/** Obtiene una empresa por id, o `null`. */
export async function obtenerEmpresa(sql: Sql, id: string): Promise<Company | null> {
  const filas = await sql<Company[]>`select ${PROYECCION(sql)} from "Company" where id = ${id}`;
  return filas[0] ?? null;
}

/**
 * Marca/desmarca una empresa como socia y audita el UPDATE.
 * @returns la empresa actualizada, o `null` si no existe.
 */
export async function marcarSocia(
  sql: Sql,
  id: string,
  esSocia: boolean,
  idActor: string | null,
): Promise<Company | null> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<Company[]>`select ${PROYECCION(tx)} from "Company" where id = ${id} for update`;
    const previa = previas[0];
    if (!previa) return null;

    const filas = await tx<Company[]>`
      update "Company" set es_socia = ${esSocia} where id = ${id} returning ${PROYECCION(tx)}
    `;
    const actualizada = filas[0]!;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Company',
      idRegistro: id,
      operacion: 'UPDATE',
      datosAnteriores: { es_socia: previa.es_socia },
      datosNuevos: { es_socia: esSocia },
    });
    return actualizada;
  });
  return (resultado as Company | null) ?? null;
}
