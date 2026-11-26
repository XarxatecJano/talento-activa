import type { Sql, ISql } from 'postgres';
import { proyectarAlumnoPublico } from './student.js';
import type { AlumnoPublico, FilaPublica } from './student.js';
import { registrarAuditoria } from './audit.js';

/**
 * Bookmarks de empresas sobre alumnos (T28). Una empresa (vía su usuario SOCIO)
 * guarda, quita y lista perfiles de interés en `Company_student_rel`.
 *
 * Reglas de negocio (enforcement en la capa de aplicación):
 * - **Solo alumnos visibles:** solo se puede guardar (y solo se listan) alumnos
 *   consultables = `activo` **y** con consentimiento (`consent_at` no nulo). Un
 *   alumno que deja de ser consultable desaparece del listado aunque la fila del
 *   bookmark siga existiendo.
 * - **Aislamiento por empresa:** cada empresa solo ve y manipula sus bookmarks
 *   (filtrado por `company_id`).
 */

/** Columnas de la proyección pública del alumno (identidad + campos privables +
 * `privacy`), para el filtrado por campo. */
const COLS_PUBLICAS_S = (sql: ISql) => sql`
  s.id, s.edition_id, s.nombre, s.foto_url, s.bio, s.ubicacion,
  s.disponibilidad_traslado, s.modalidad, s.estado_laboral, s.cv_url,
  s.linkedin, s.github, s.privacy
`;

/**
 * Proyecta las filas públicas de los alumnos guardados como cards públicas
 * (reutiliza `proyectarAlumnoPublico`, con la privacidad por campo aplicada).
 * Función pura y testable sin BD. Conserva el orden de entrada.
 */
export function proyectarBookmarks(filas: FilaPublica[]): AlumnoPublico[] {
  return filas.map(proyectarAlumnoPublico);
}

/**
 * Resuelve el id de la empresa asociada a un usuario SOCIO vía `Company_user_rel`.
 * Devuelve `null` si el usuario no está vinculado a ninguna empresa.
 */
export async function obtenerEmpresaDeUsuario(sql: Sql, userId: string): Promise<string | null> {
  const filas = await sql<{ company_id: string }[]>`
    select company_id from "Company_user_rel" where user_id = ${userId} limit 1
  `;
  return filas[0]?.company_id ?? null;
}

/** Resultado de guardar un bookmark. */
export type ResultadoGuardar = 'ok' | 'duplicado' | 'sin-alumno';

/**
 * Guarda un bookmark de la empresa sobre un alumno. Solo si el alumno es
 * **consultable** (activo + consentido); en otro caso devuelve `'sin-alumno'`
 * sin tocar nada. Idempotente: si ya existía devuelve `'duplicado'`. Audita el
 * INSERT cuando efectivamente se crea.
 */
export async function guardarBookmark(
  sql: Sql,
  companyId: string,
  studentId: string,
  idActor: string | null,
): Promise<ResultadoGuardar> {
  const resultado = await sql.begin(async (tx): Promise<ResultadoGuardar> => {
    const visible = await tx<{ id: string }[]>`
      select id from "Student"
      where id = ${studentId} and estado = 'activo' and consent_at is not null
    `;
    if (visible.length === 0) return 'sin-alumno';

    const res = await tx`
      insert into "Company_student_rel" (company_id, student_id)
      values (${companyId}, ${studentId})
      on conflict (company_id, student_id) do nothing
    `;
    if (res.count === 0) return 'duplicado';

    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Company_student_rel',
      idRegistro: studentId,
      operacion: 'INSERT',
      datosNuevos: { company_id: companyId, student_id: studentId },
    });
    return 'ok';
  });
  return resultado as ResultadoGuardar;
}

/**
 * Quita un bookmark de la empresa sobre un alumno. Idempotente: devuelve `true`
 * si existía y se borró, `false` si no había nada. Audita el DELETE cuando borra.
 * El aislamiento por empresa va en el `where` (`company_id`).
 */
export async function quitarBookmark(
  sql: Sql,
  companyId: string,
  studentId: string,
  idActor: string | null,
): Promise<boolean> {
  const borrado = await sql.begin(async (tx) => {
    const res = await tx`
      delete from "Company_student_rel"
      where company_id = ${companyId} and student_id = ${studentId}
    `;
    if (res.count === 0) return false;

    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Company_student_rel',
      idRegistro: studentId,
      operacion: 'DELETE',
      datosAnteriores: { company_id: companyId, student_id: studentId },
    });
    return true;
  });
  return borrado as boolean;
}

/**
 * Lista los perfiles guardados por una empresa, como cards públicas (privacidad
 * por campo aplicada). **Solo** alumnos actualmente consultables (activo +
 * consentido): un alumno que ya no lo sea no aparece, aunque el bookmark siga en
 * la tabla. Aislamiento por `company_id`. Orden: más recientes primero.
 */
export async function listarBookmarks(sql: Sql, companyId: string): Promise<AlumnoPublico[]> {
  const filas = await sql<FilaPublica[]>`
    select ${COLS_PUBLICAS_S(sql)}
    from "Company_student_rel" r
    join "Student" s on s.id = r.student_id
    where r.company_id = ${companyId}
      and s.estado = 'activo' and s.consent_at is not null
    order by r.created_at desc
  `;
  return proyectarBookmarks(filas);
}
