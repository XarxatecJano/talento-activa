/**
 * Error de datos no válidos (entrada que incumple una regla de dominio, p. ej.
 * longitud de contraseña fuera de rango). La capa de controlador lo mapea a un
 * 400/422 de la API.
 */
export class DatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatosInvalidosError';
  }
}
