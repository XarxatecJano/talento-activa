import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/model/db.js';
import { crearUsuario } from '../../src/model/user.js';
import { crearSesion } from '../../src/model/session.js';
import { crearApp } from '../../src/controller/app.js';

// Hallazgo MENOR 1 (revisión 2026-11-27): el alta de alumno
// (`POST /api/alumnos`) solo comprobaba `typeof edition_id === 'string'`, de modo
// que un valor no-UUID (p. ej. `"abc"`) llegaba a la inserción contra la columna
// `uuid` `Student.edition_id`, provocaba el error `22P02` de Postgres y un 500
// espurio. Debe traducirse a 400 «Datos no válidos» en el controlador, igual que
// el resto de identificadores se validan con `esUuid` (ver fb31a24). Requiere BD
// (sesión real); si no la hay, el test se salta.

const raw = process.env.DATABASE_URL?.trim() ?? '';
const hasDb = raw.length > 0 && !raw.includes('<');
const PASSWORD = 'contraseña-segura-123';
const emailUnico = (p: string) =>
  `alta-uuid-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;

type Db = ReturnType<typeof createDb>;

async function borrarUsuario(sql: Db, userId: string) {
  await sql`delete from "Audit_log" where id_registro = ${userId} or id_usuario = ${userId}`;
  await sql`delete from "User" where id = ${userId}`; // cascade: Student, tokens, sesiones
}

/** ADMIN con sesión (la ruta no exige verificación de email; ver MENOR 4). */
async function admin(sql: Db) {
  const u = await crearUsuario(sql, { email: emailUnico('admin'), password: PASSWORD, rol: 'ADMIN' }, null);
  const { token } = await crearSesion(sql, u.id);
  return { adminId: u.id, cookie: `sesion=${token}` };
}

function post(app: ReturnType<typeof crearApp>, path: string, cookie: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe('controller/alumnos — alta con edition_id no-UUID (MENOR 1)', () => {
  it.runIf(hasDb)('edition_id no-UUID → 400 «Datos no válidos», sin crear usuario', async () => {
    const sql = createDb();
    const app = crearApp(sql);
    const { adminId, cookie } = await admin(sql);
    const email = emailUnico('nuevo');
    try {
      const res = await post(app, '/api/alumnos', cookie, {
        email,
        password: PASSWORD,
        nombre: 'Ada Lovelace',
        edition_id: 'abc', // no es un UUID
      });
      expect(res.status).toBe(400);
      const cuerpo = (await res.json()) as { error?: string };
      expect(cuerpo.error).toBe('Datos no válidos');

      // El alta debe rechazarse antes de tocar el modelo: no queda ningún usuario
      // huérfano con ese email.
      const filas = await sql`select 1 from "User" where email = ${email.toLowerCase()}`;
      expect(filas).toHaveLength(0);
    } finally {
      await borrarUsuario(sql, adminId);
      await sql.end();
    }
  });
});
