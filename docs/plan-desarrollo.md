# Plan de desarrollo — App Alumnos Xarxatec Activa

Documento que gobierna el trabajo **autónomo** del agente Desarrollador y del
agente Revisor. El Desarrollador trabaja sobre la rama `develop`.

## Protocolo del Desarrollador (cada ejecución, 06:00–22:00 cada hora)

En cada conexión, de forma autónoma:

1. **Sincroniza:** sitúate en `develop` y haz `git pull` (si no existe en remoto,
   créala desde `master`).
2. **Prioriza el trabajo de esta ejecución, en este orden:**
   1. **Cambios propuestos por el Revisor** aún abiertos: lee el informe abierto
      más reciente en `docs/revisiones/` (los marcados `ESTADO: ABIERTO`) y
      resuelve sus hallazgos **bloqueantes** primero.
   2. Si no hay hallazgos abiertos, coge la **siguiente tarea pendiente** (primera
      `[ ]` sin terminar) del Backlog de abajo, respetando el orden.
3. **Desarrolla con TDD:** rojo → verde → refactor. Nada de código de producción
   sin un test que lo pida (ver `CLAUDE.md`).
4. **Alcance por ejecución:** avanza en incrementos pequeños y dejables. Si una
   tarea no cabe en una hora, haz un commit con progreso coherente y tests en
   verde; continúa en la siguiente conexión.
5. **Al terminar una tarea o sub-tarea:**
   - Ejecuta toda la suite de tests y `node scripts/check-locked-tests.mjs check`.
   - **Bloquea** los tests de lo acabado:
     `node scripts/check-locked-tests.mjs lock <rutas...>`.
   - Marca la tarea como `[x]` en este documento.
   - Si resolviste hallazgos de un informe de revisión y no quedan abiertos en él,
     cambia su cabecera a `ESTADO: RESUELTO`.
6. **Commit y push a `develop`** (ver convención). No hagas merge a `master`.
7. **Nunca** modifiques un test bloqueado. Si crees que es imprescindible, **no lo
   toques**: déjalo anotado en el commit/resumen y en el informe de revisión para
   que un humano dé el OK.

### Definición de "hecho" (Definition of Done)

- Tests que cubren el comportamiento, escritos antes del código, en verde.
- `check-locked-tests` en verde y tests de la tarea **bloqueados**.
- Cumple los invariantes de seguridad y la arquitectura MVC de `CLAUDE.md`.
- Commit(s) en `develop` con mensaje según convención.

### Convención de commits

`tipo(ámbito): descripción` — tipos: `feat`, `fix`, `test`, `refactor`, `chore`,
`docs`. Ejemplos: `feat(auth): login con anti-enumeración`,
`test(session): expiración y renovación deslizante`.

## Protocolo del Revisor (una vez al día, 00:00)

1. Sitúate en `develop` y haz `git pull`.
2. Revisa **todo el código generado ese día** (commits de `develop` con fecha de
   hoy: `git log --since=midnight`).
3. Audita según `revisor.md` (seguridad, TDD y tests bloqueados, corrección, MVC,
   convenciones, simplicidad). Ejecuta tests y `check-locked-tests`.
4. **Escribe el informe** en `docs/revisiones/AAAA-MM-DD.md` con esta cabecera:

   ```
   # Revisión AAAA-MM-DD
   ESTADO: ABIERTO            # ABIERTO mientras haya hallazgos sin resolver
   VEREDICTO: CAMBIOS NECESARIOS | APROBADO
   ```

   Debajo, los hallazgos ordenados por severidad, cada uno con: fichero:línea,
   qué está mal, por qué, y la corrección sugerida (describir, no aplicar).
5. El Revisor **no modifica código**; solo deja el informe para el Desarrollador.

---

## Backlog de tareas (Fase 1 — Núcleo)

> Orden por dependencias. El Desarrollador coge la primera `[ ]` no terminada.

### Bootstrap
- [x] **T00 · Andamiaje del proyecto:** `package.json` (TS), runner de tests
  (vitest), `tsconfig`, estructura de carpetas MVC (`src/model`, `src/controller`,
  `src/view`, `tests/`), scripts `test`/`build`. Primer test trivial en verde.
- [x] **T01 · Cliente de datos:** conexión a Supabase/Postgres desde el backend
  (service role / conexión directa). Test de conectividad/consulta básica.
- [x] **T02 · Capa de auditoría:** helper que escribe en `Audit_log` desde la capa
  de aplicación (nunca hash ni token). Test de inserción y de exclusiones.

### Autenticación
- [x] **T03 · Hashing de contraseñas:** Argon2id `m=19456,t=2,p=1`; validación de
  longitud 12–256 → error de datos no válidos. Tests de hash/verify y límites.
- [x] **T04 · Modelo User:** alta por invitación (rol, `email_verified=false`),
  email único sobre `lower(email)`. Tests.
- [x] **T05 · Sesiones:** token opaco 32 bytes base64url; guardar solo SHA-256;
  resolver sesión (null + borrado si no existe/caduca/usuario inexistente) y
  devolver `Actor {id, rol}`; renovación deslizante (<15 días → 30). Tests.
- [x] **T06 · Cookie de sesión:** helpers para `sesion` (`HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` en prod, `Expires` absoluto). Tests.
- [x] **T07 · Login:** `POST /api/auth/login` crea sesión nueva e invalida la
  previa de la cookie; anti-enumeración con `HASH_SEÑUELO` (mismo error y mismo
  coste temporal). Tests incl. tiempos.
- [x] **T08 · Logout y /me:** `POST /api/auth/logout` (idempotente, limpia cookie)
  y `GET /api/me` (proyección pública sin hash). Tests.
- [x] **T09 · Middleware de autorización:** resuelve sesión y exige rol por ruta.
  Tests de acceso por rol.
- [x] **T10 · Registro restringido:** `POST /api/auth/register` solo ADMIN (alta por
  invitación). Tests.
- [x] **T11 · Verificación de email:** token de un solo uso con caducidad + envío;
  bloquear acceso hasta verificar. Tests.
  > Nota: el bloqueo se hace con el middleware `requiereEmailVerificado` (se
  > aplicará a las rutas de recursos desde T15); login/logout/me no bloquean a no
  > verificados para no romper tests ya bloqueados (decisión acordada con el
  > responsable el 2026-11-26).

### Administración
- [x] **T12 · Ediciones:** CRUD de `Edition` (crear, cerrar). Tests.
- [x] **T13 · Alta de alumnos finalizados:** crear `Student` (usuario ALUMNO) y
  asociar a una edición. Tests.
- [x] **T14 · Alta de empresas:** crear `Company` por invitación y marcar `es_socia`.
  Tests.

### Alumno
- [x] **T15 · Ficha de alumno:** modelo `Student` + endpoints de lectura/edición de
  su ficha; `privacy` por campo. Tests.
- [x] **T16 · Estado activo/inactivo:** el alumno (y el admin) cambian `estado`;
  un `inactivo` no es consultable por empresas. Tests de enforcement.
- [x] **T17 · Derecho al olvido:** borrado en cascada de datos del alumno. Tests.
- [x] **T18 · Proyectos:** CRUD de `Project` vinculado al alumno; validar URL;
  miniatura por subida manual. Tests.
- [x] **T19 · Skills e idiomas:** catálogo + asociación N:M con nivel
  (`Skill_student_rel`, `Language_student_rel`). Tests.
- [x] **T20 · Consentimiento al publicar (RGPD):** endpoint de consentimiento
  (`POST /api/alumnos/me/consentimiento`, fija `consent_at`) y enforcement: un
  alumno sin `consent_at` no es consultable por empresas. Tests. (Añadida tras la
  revisión 2026-11-26, hallazgo MEDIO 1; con OK del responsable para actualizar el
  test bloqueado `estado.test.ts`.)

> Fases 3 (automatizaciones/emails) y 4 (chatbot) se detallarán cuando la Fase 2
> esté cerrada y revisada.

## Backlog de tareas (Fase 2 — Escaparate y empresas)

> Detallada el 2026-11-26. **Decisiones de producto tomadas con el responsable:**
> (1) el escaparate es **solo para empresas autenticadas** (SOCIO verificado), no
> público en internet; (2) el **frontend** (VanillaJS + TS) se desarrolla **en
> paralelo** al backend; (3) el **contacto** se hace **revelando el email** del
> alumno a la empresa cuando el alumno ha consentido (y la privacidad lo permite),
> no por relay.
>
> Convenciones nuevas: endpoints de escaparate bajo `/api/escaparate/*`, todos tras
> `requiereAuth` + `requiereRol('SOCIO')` + `requiereEmailVerificado`. Siguen TDD y
> tests bloqueados. El frontend se prueba con vitest (jsdom) y/o E2E.

### Habilitadores
- [ ] **T21 · Supabase Storage:** abstracción `Almacenamiento` (como
  `EnviadorEmail`) + implementación Supabase; buckets para **foto de alumno, CV y
  miniatura de proyecto**; subida (URLs firmadas o proxy) y borrado; guardar la URL
  en la ficha/proyecto. Tests con doble de almacenamiento.
- [ ] **T22 · Email real (Resend):** implementación real detrás de `EnviadorEmail`
  (hoy *noop*), configurada por entorno (API key en `.env`/`.env.local`), para que
  la **verificación** envíe de verdad en producción. En test/dev se usa el doble.

### Escaparate (lectura; solo SOCIO)
- [x] **T23 · Privacidad por campo:** define la forma de `Student.privacy`
  (propuesta: `{ "<campo>": boolean }`, visible por defecto salvo `false`) y aplica
  el filtrado en la proyección pública. Resuelve el MEDIO 2 aplazado. Test de
  enforcement (campo privado no aparece). **Hecho:** `campoVisible`,
  `proyectarAlumnoPublico` (pura, reutilizable) y `CAMPOS_PRIVABLES` en
  `student.ts`; `obtenerAlumnoPublico` aplica el filtrado. La identidad
  (`id`/`edition_id`/`nombre`) nunca se oculta. Tests en `tests/model/privacy.test.ts`.
- [x] **T24 · Ediciones → cards de alumnos:** `GET /api/escaparate/ediciones` y
  `.../ediciones/:id` devuelven los alumnos **activos + consentidos** de la edición,
  proyección pública con `privacy` aplicada. Oculta inactivos/no-consentidos/
  privados. Tests. **Hecho:** `src/model/escaparate.ts` (`agruparEscaparate` pura +
  `listarEscaparate`/`obtenerEdicionEscaparate` con enforcement en SQL), endpoints
  bajo `/api/escaparate/*` tras `requiereAuth`+`requiereRol('SOCIO')`+
  `requiereEmailVerificado`. Reutiliza `proyectarAlumnoPublico` (T23). Tests en
  `tests/model/escaparate.test.ts` y `tests/controller/escaparate.test.ts`.
- [x] **T25 · Escaparate de proyectos:** `GET /api/escaparate/proyectos` con
  miniatura, respetando la visibilidad del alumno dueño. Tests. **Hecho:**
  `proyectarProyectoEscaparate` (pura: combina los campos públicos del proyecto
  con la card del alumno dueño vía `proyectarAlumnoPublico`) y
  `listarProyectosEscaparate` (join `Project`×`Student` con enforcement en SQL:
  solo dueños activos + consentidos) en `src/model/escaparate.ts`; endpoint
  `GET /api/escaparate/proyectos` tras `requiereAuth`+`requiereRol('SOCIO')`+
  `requiereEmailVerificado`. Un proyecto no tiene privacidad propia: se expone
  solo si su alumno dueño es consultable, y la card del dueño respeta `privacy`.
  Tests en `tests/model/proyectos-escaparate.test.ts` (puros, verifican el
  filtrado) y `tests/controller/proyectos-escaparate.test.ts` (permisos +
  enforcement, requieren BD).
- [ ] **T26 · Búsqueda y filtrado estructurado:** `GET /api/escaparate/alumnos` con
  filtros combinables (`skill`, `edicion`, `modalidad`, `disponibilidad`,
  `estado_laboral`), solo sobre visibles. Tests de combinaciones.
- [ ] **T27 · Ficha completa para empresa + contacto:** `GET /api/escaparate/alumnos/:id`
  con la ficha pública (privacy aplicada) **incluyendo el email de contacto** cuando
  el alumno consintió y no lo marcó privado (contacto por revelación). Tests.

### Empresa (acciones; solo SOCIO)
- [ ] **T28 · Bookmarks:** `Company_student_rel` — guardar/quitar/listar perfiles de
  interés de la empresa; solo alumnos visibles; aislamiento por empresa. Tests.
- [ ] **T29 · Alumnos en empresas socias:** gestión de `Student.current_company_id`
  (asignar/quitar, por admin) y sección "alumnos que trabajan en empresas socias".
  Tests.

### Frontend (VanillaJS + TypeScript) — en paralelo
- [ ] **T30 · Andamiaje frontend:** bundler (vite), estructura en `src/view/`,
  build y servir estáticos (dev server + producción desde Hono). Primer render.
- [ ] **T31 · UI de autenticación:** login/logout y estado de sesión (`/api/me`).
- [ ] **T32 · UI de la ficha del alumno:** editar ficha, estado, consentimiento,
  proyectos, skills/idiomas y subidas (foto/CV/miniatura).
- [ ] **T33 · UI de empresa (escaparate):** cards por edición, búsqueda/filtro,
  ficha de alumno, bookmarks y contacto.
- [ ] **T34 · UI de administración:** ediciones, alta de alumnos y empresas,
  marcado de socia, estados.

> Orden sugerido: T21/T22 (habilitadores) → T23 → T24/T25/T26/T27 → T28/T29. El
> frontend (T30→T34) avanza en paralelo según haya endpoints; T30 primero.

## Decisiones de cierre de Fase 1 (revisión 2026-11-26)

Documentadas a raíz de la auditoría `docs/revisiones/2026-11-26.md`:

- **Auditoría de sesiones/tokens (MENOR 3):** `crearSesion`,
  `eliminarSesionPorToken` y `crearTokenVerificacion` **no** escriben en
  `Audit_log` a propósito: son plomería de autenticación (ruido alto por
  petición) y nunca se auditaría el secreto. `verificarEmail` sí audita el cambio
  de `email_verified`. El invariante "cada mutación audita" se aplica a las
  mutaciones de **datos de negocio**.
- **Longitud de contraseña (MENOR 5):** `validarLongitudPassword` mide con
  `String.length` (unidades UTF-16). Es el criterio aceptado para el rango 12–256.

- **Consentimiento al publicar (MEDIO 1):** RESUELTO en T20 (el responsable dio OK
  para actualizar `estado.test.ts`).
- **Filtrado `privacy` por campo (MEDIO 2):** ~~APLAZADO a Fase 2~~ **RESUELTO en
  T23** (2026-11-26). Regla: un campo se oculta de la proyección pública solo si
  `privacy[campo] === false`; la identidad (`id`/`edition_id`/`nombre`) nunca se
  oculta. `obtenerAlumnoPublico` aplica el filtrado vía `proyectarAlumnoPublico`.
- **Verificación de email en rutas de admin (MENOR 4):** ACEPTADO como está. El
  admin inicial nace verificado (seed); endurecerlo requeriría tocar tests
  bloqueados y se deja para más adelante si hiciera falta.

Todos los hallazgos de la revisión 2026-11-26 están resueltos o con decisión
tomada. **Fase 1 cerrada.**
