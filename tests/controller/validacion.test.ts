import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { esUuid, uuidParam } from '../../src/controller/validacion.js';
import { parsearFiltrosAlumno } from '../../src/controller/app.js';

// Tests puros (sin BD) del hallazgo MEDIO 1 de la revisión 2026-11-26:
// identificadores no-UUID que acaban comparándose con columnas `uuid` de Postgres
// deben rechazarse en el controlador (404/400) antes de tocar el modelo, para no
// provocar un error 22P02 y un 500 espurio.

describe('controller/validacion — esUuid', () => {
  it('acepta UUIDs bien formados (cualquier versión, mayús/minús)', () => {
    expect(esUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(esUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(esUuid('123E4567-E89B-12D3-A456-426614174000')).toBe(true);
  });

  it('rechaza cadenas que no son UUID', () => {
    for (const v of [
      'abc',
      '',
      '123',
      '123e4567-e89b-12d3-a456-42661417400', // 11 hex en el último grupo
      '123e4567e89b12d3a456426614174000', // sin guiones
      '123e4567-e89b-12d3-a456-426614174000 ', // espacio final
      'g23e4567-e89b-12d3-a456-426614174000', // carácter no hex
    ]) {
      expect(esUuid(v)).toBe(false);
    }
  });

  it('rechaza valores que no son string', () => {
    expect(esUuid(undefined)).toBe(false);
    expect(esUuid(null)).toBe(false);
    expect(esUuid(123)).toBe(false);
    expect(esUuid({})).toBe(false);
  });
});

describe('controller/validacion — uuidParam (middleware)', () => {
  const app = new Hono();
  app.get('/r/:id', uuidParam(), (c) => c.json({ ok: true }));
  app.get('/otro/:slug', uuidParam('slug'), (c) => c.json({ ok: true }));

  it('deja pasar cuando el parámetro es un UUID válido', async () => {
    const res = await app.request('/r/123e4567-e89b-12d3-a456-426614174000');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('responde 404 cuando el parámetro no es un UUID', async () => {
    const res = await app.request('/r/abc');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No encontrado' });
  });

  it('valida el parámetro nombrado que se le indique', async () => {
    expect((await app.request('/otro/no-uuid')).status).toBe(404);
    expect((await app.request('/otro/00000000-0000-0000-0000-000000000000')).status).toBe(200);
  });
});

describe('controller/app — parsearFiltrosAlumno rechaza ids no-UUID (MEDIO 1)', () => {
  it('skill/edicion no-UUID → null (el handler responde 400)', () => {
    expect(parsearFiltrosAlumno({ skill: 'no-uuid' })).toBeNull();
    expect(parsearFiltrosAlumno({ edicion: 'no-uuid' })).toBeNull();
  });

  it('skill/edicion con UUID válido → filtros aceptados', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(parsearFiltrosAlumno({ skill: uuid })).toEqual({ skill: uuid });
    expect(parsearFiltrosAlumno({ edicion: uuid })).toEqual({ edicion: uuid });
  });

  it('sin parámetros → {} (listar todos los visibles)', () => {
    expect(parsearFiltrosAlumno({})).toEqual({});
  });

  it('sigue validando los enums (modalidad no válida → null)', () => {
    expect(parsearFiltrosAlumno({ modalidad: 'teletrabajo' })).toBeNull();
    expect(parsearFiltrosAlumno({ modalidad: 'remoto' })).toEqual({ modalidad: 'remoto' });
  });
});
