/**
 * Abstracción del envío de email transaccional (verificación, recordatorios...).
 * La implementación real (p. ej. Resend) se inyectará en producción; los tests
 * inyectan un doble que captura los envíos.
 */
export interface EnviadorEmail {
  /** Envía el email de verificación con el token de un solo uso. */
  enviarVerificacion(destino: string, token: string): Promise<void>;
}

/** Enviador por defecto: no hace nada. Útil en dev/test sin proveedor configurado. */
export const enviadorNoop: EnviadorEmail = {
  async enviarVerificacion(): Promise<void> {
    /* no-op */
  },
};
