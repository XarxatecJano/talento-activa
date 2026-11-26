import { describe, it, expect } from 'vitest';
import { proyectarBookmarks } from '../../src/model/bookmark.js';
import type { FilaPublica } from '../../src/model/student.js';

function fila(over: Partial<FilaPublica> = {}): FilaPublica {
  return {
    id: 'st-1',
    edition_id: 'ed-1',
    nombre: 'Katherine',
    foto_url: null,
    bio: null,
    ubicacion: 'Castellón',
    disponibilidad_traslado: false,
    modalidad: 'remoto',
    estado_laboral: 'buscando',
    cv_url: null,
    linkedin: 'https://linkedin/kj',
    github: null,
    privacy: {},
    ...over,
  };
}

describe('model/bookmark — proyectarBookmarks (proyección pública de los perfiles guardados)', () => {
  it('lista vacía → []', () => {
    expect(proyectarBookmarks([])).toEqual([]);
  });

  it('proyecta cada fila como card pública (sin email ni privacy) conservando el orden', () => {
    const cards = proyectarBookmarks([
      fila({ id: 'a', nombre: 'Ana' }),
      fila({ id: 'b', nombre: 'Beto' }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cards.map((c) => c.nombre)).toEqual(['Ana', 'Beto']);
    for (const card of cards) {
      expect(Object.prototype.hasOwnProperty.call(card, 'privacy')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(card, 'email')).toBe(false);
    }
  });

  it('aplica la privacidad por campo: un campo marcado privado no aparece; la identidad siempre va', () => {
    const card = proyectarBookmarks([fila({ privacy: { linkedin: false, ubicacion: false } })])[0]!;
    expect(Object.prototype.hasOwnProperty.call(card, 'linkedin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(card, 'ubicacion')).toBe(false);
    // Identidad y campos visibles presentes.
    expect(card.id).toBe('st-1');
    expect(card.edition_id).toBe('ed-1');
    expect(card.nombre).toBe('Katherine');
    expect(card.modalidad).toBe('remoto');
  });
});
