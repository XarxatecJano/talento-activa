import { config } from 'dotenv';

/**
 * Carga las variables de entorno según el entorno de ejecución:
 *
 * - **Producción** (`NODE_ENV=production`): solo `.env` (BD de producción). En el
 *   servidor desplegado NO existe `.env.local`.
 * - **Desarrollo/test** (por defecto): `.env` como base y `.env.local` con
 *   prioridad (BD de desarrollo). Así `npm run dev` y los tests nunca tocan la BD
 *   de producción si `.env.local` apunta a la de desarrollo.
 *
 * Ambos ficheros están en `.gitignore`; `.env.example` documenta el formato.
 */
export function cargarEnv(): void {
  config(); // .env (base / producción)
  if (process.env.NODE_ENV !== 'production') {
    config({ path: '.env.local', override: true }); // desarrollo: prioridad
  }
}
