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

/**
 * El email ya está registrado. Mensaje genérico a propósito (anti-enumeración):
 * la capa de controlador lo mapea a un 409 sin revelar si el email existía.
 */
export class EmailYaRegistradoError extends Error {
  constructor(message = 'No se ha podido completar el registro') {
    super(message);
    this.name = 'EmailYaRegistradoError';
  }
}
