import { describe, it, expect } from 'vitest';
import { crearApp } from '../../src/controller/app.js';

// No necesita BD: es solo una señal de vida. Pasamos un sql ficticio.
const sqlFicticio = {} as Parameters<typeof crearApp>[0];

describe('controller/health — GET /api/health', () => {
  it('responde 200 con {status:"ok"} sin requerir sesión', async () => {
    const app = crearApp(sqlFicticio);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
