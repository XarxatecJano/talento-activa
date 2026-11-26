// Crea (o reactiva) el usuario ADMIN inicial, verificado.
// Uso: tsx scripts/crear-admin.ts <email> <password>
// El hash Argon2id se genera aquí (el seed.sql deja esto al backend a propósito).
import { cargarEnv } from '../src/env.js';
import { createDb } from '../src/model/db.js';
import { crearUsuario } from '../src/model/user.js';
import { crearTokenVerificacion, verificarEmail } from '../src/model/email_verification.js';
import { EmailYaRegistradoError } from '../src/model/errors.js';

// Por defecto opera sobre el entorno de desarrollo (.env.local). Para crear el
// admin en producción: `NODE_ENV=production npm run crear-admin -- <email> <pass>`.
cargarEnv();

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error('Uso: tsx scripts/crear-admin.ts <email> <password>');
  process.exit(1);
}

const sql = createDb();
try {
  const admin = await crearUsuario(sql, { email, password, rol: 'ADMIN' });
  // Lo dejamos verificado para que pueda operar desde ya.
  const { token } = await crearTokenVerificacion(sql, admin.id);
  await verificarEmail(sql, token);
  console.log(`✓ ADMIN creado y verificado: ${admin.email} (id ${admin.id})`);
} catch (err) {
  if (err instanceof EmailYaRegistradoError) {
    console.error(`✗ Ya existe un usuario con ese email: ${email}`);
    process.exit(1);
  }
  throw err;
} finally {
  await sql.end();
}
