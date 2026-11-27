import type { Sql } from 'postgres';
import { proyectarAlumnoPublico } from './student.js';
import type { AlumnoPublico, FilaPublica } from './student.js';
import { registrarAuditoria } from './audit.js';

/**
 * Alumnos que trabajan en empresas socias (T29). Dos responsabilidades:
 *
 * 1. **Gestión (admin):** asignar/quitar `Student.current_company_id`, la empresa
 *    socia en la que el alumno trabaja actualmente. Solo se admiten empresas
 *    **socias** (`es_socia = true`): el campo representa empleo en una empresa
 *    socia de la asociación.
 * 2. **Sección (empresas):** listado de los alumnos que trabajan en empresas
 *    socias, con su empresa. Enforcement de visibilidad igual que el resto del
 *    escaparate: solo alumnos **consultables** (`activo` + con consentimiento) y
 *    con la privacidad por campo aplicada. Un alumno asignado pero no consultable
 *    no aparece.
 */

/** Empresa actual del alumno en la proyección pública (identidad mínima). */
export interface EmpresaActual {
  id: string;
  nombre: string;
}

/** Card pública de un alumno con la empresa socia en la que trabaja. */
export interface AlumnoEnEmpresa extends AlumnoPublico {
  empresa: EmpresaActual;
}

/**
 * Fila del join `Student`×`Company` (empresa actual) para la proyección pública:
 * las columnas públicas del alumno más el id/nombre de su empresa.
 */
export interface FilaAlumnoEnEmpresa extends FilaPublica {
  empresa_id: string;
  empresa_nombre: string;
}

/**
 * Proyecta una fila a card pública con su empresa: reutiliza
 * `proyectarAlumnoPublico` (privacidad por campo aplicada, sin email ni privacy)
 * y añade la empresa. Función pura y testable sin BD.
 */
export function proyectarAlumnoEnEmpresa(fila: FilaAlumnoEnEmpresa): AlumnoEnEmpresa {
  const card = proyectarAlumnoPublico(fila) as AlumnoEnEmpresa;
  card.empresa = { id: fila.empresa_id, nombre: fila.empresa_nombre };
  return card;
}

/** Proyecta un listado conservando el orden de entrada. */
export function proyectarAlumnosEnEmpresas(filas: FilaAlumnoEnEmpresa[]): AlumnoEnEmpresa[] {
  return filas.map(proyectarAlumnoEnEmpresa);
}

/** Resultado de asignar la empresa actual de un alumno. */
export type ResultadoAsignar = 'ok' | 'sin-alumno' | 'sin-empresa';

/**
 * Asigna la empresa actual (`current_company_id`) de un alumno (uso: admin). La
 * empresa debe existir y ser **socia** (`es_socia = true`); en otro caso devuelve
 * `'sin-empresa'` sin tocar nada. Si el alumno no existe devuelve `'sin-alumno'`.
 * Audita el UPDATE con el diff de `current_company_id`.
 */
export async function asignarEmpresaActual(
  sql: Sql,
  studentId: string,
  companyId: string,
  idActor: string | null,
): Promise<ResultadoAsignar> {
  const resultado = await sql.begin(async (tx): Promise<ResultadoAsignar> => {
    const previas = await tx<{ id: string; current_company_id: string | null }[]>`
      select id, current_company_id from "Student" where id = ${studentId} for update
    `;
    const previa = previas[0];
    if (!previa) return 'sin-alumno';
    // Reasignar la misma empresa es un no-op idempotente: no hay cambio, así que
    // no se hace UPDATE ni se audita (mismo patrón que `quitarEmpresaActual`).
    if (previa.current_company_id === companyId) return 'ok';

    const empresas = await tx<{ id: string }[]>`
      select id from "Company" where id = ${companyId} and es_socia = true
    `;
    if (empresas.length === 0) return 'sin-empresa';

    await tx`update "Student" set current_company_id = ${companyId} where id = ${studentId}`;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: studentId,
      operacion: 'UPDATE',
      datosAnteriores: { current_company_id: previa.current_company_id },
      datosNuevos: { current_company_id: companyId },
    });
    return 'ok';
  });
  return resultado as ResultadoAsignar;
}

/**
 * Quita la empresa actual de un alumno (`current_company_id = null`; uso: admin).
 * Devuelve `false` si el alumno no existe. Idempotente: si ya estaba a `null` no
 * audita (no hubo cambio) pero devuelve `true`. Audita el UPDATE cuando cambia.
 */
export async function quitarEmpresaActual(
  sql: Sql,
  studentId: string,
  idActor: string | null,
): Promise<boolean> {
  const resultado = await sql.begin(async (tx) => {
    const previas = await tx<{ id: string; current_company_id: string | null }[]>`
      select id, current_company_id from "Student" where id = ${studentId} for update
    `;
    const previa = previas[0];
    if (!previa) return false;
    if (previa.current_company_id === null) return true; // ya sin empresa: no-op.

    await tx`update "Student" set current_company_id = null where id = ${studentId}`;
    await registrarAuditoria(tx, {
      idUsuario: idActor,
      tabla: 'Student',
      idRegistro: studentId,
      operacion: 'UPDATE',
      datosAnteriores: { current_company_id: previa.current_company_id },
      datosNuevos: { current_company_id: null },
    });
    return true;
  });
  return resultado as boolean;
}

/**
 * Sección "alumnos que trabajan en empresas socias": los alumnos **consultables**
 * (activo + consentido) cuya `current_company_id` apunta a una empresa **socia**,
 * con su empresa y la privacidad por campo aplicada. Enforcement en SQL; los
 * alumnos inactivos/sin consentimiento o cuya empresa no es socia nunca aparecen.
 * Orden: por nombre del alumno.
 */
export async function listarAlumnosEnEmpresasSocias(sql: Sql): Promise<AlumnoEnEmpresa[]> {
  const filas = await sql<FilaAlumnoEnEmpresa[]>`
    select
      s.id, s.edition_id, s.nombre, s.foto_url, s.bio, s.ubicacion,
      s.disponibilidad_traslado, s.modalidad, s.estado_laboral, s.cv_url,
      s.linkedin, s.github, s.privacy,
      c.id as empresa_id, c.nombre as empresa_nombre
    from "Student" s
    join "Company" c on c.id = s.current_company_id
    where s.estado = 'activo' and s.consent_at is not null and c.es_socia = true
    order by s.nombre
  `;
  return proyectarAlumnosEnEmpresas(filas);
}
