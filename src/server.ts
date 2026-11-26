import { serve } from '@hono/node-server';
import { config } from 'dotenv';
import { createDb } from './model/db.js';
import { crearApp } from './controller/app.js';

// Carga .env (DATABASE_URL, etc.).
config();

const sql = createDb();
const app = crearApp(sql);
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API escuchando en http://localhost:${info.port}`);
});
