import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Los tests de integración golpean una BD Supabase remota (pooler) y hacen
    // hashing Argon2; damos margen frente a la latencia de red.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
