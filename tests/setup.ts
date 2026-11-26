// Carga las variables de entorno antes de los tests. En desarrollo/test se usa
// .env.local (BD de desarrollo) con prioridad sobre .env, de modo que los tests
// no toquen la BD de producción. Ver src/env.ts y .env.example.
import { cargarEnv } from '../src/env.js';

cargarEnv();
