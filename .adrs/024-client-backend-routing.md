# ADR-024: fachada cliente y routing estricto de backend

- Gate: `G-remote-client-routing` · Deriva de: `G-remote-backend-rfc` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

El RFC exige backend local por omisión y remoto como autoridad única al configurarlo. Hoy varios adapters leen `readState`, los mutadores entran por `mutate`, y plugins/UI pueden abrir rutas alternativas. Una caída o error de auth no debe revelar ni operar sobre una copia local accidental.

## Decisión

- Introducir una fachada de backend en el boundary Application Operations/CLI adapters, antes de storage/kernel; no hacer transport-aware providers/kernel.
- Ausencia de `backend` conserva la ruta local existente. `backend.type=remote` selecciona solo HTTP(S); fallo de red/auth/schema retorna error, nunca retry/fallback local.
- Routing v1: lecturas `status`, `context`, `show`, `history`, `search`, `initiatives`, `log`, `state`; mutaciones built-in y core/batch; `init` remoto solo provisiona con permiso explícito.
- `push`, `pull`, `transfers`, `transfer-status` son excepciones explícitas para transferencias/journal. `snapshots`, `restore`, UI, plugin query/data y extensiones no mapeadas devuelven `REMOTE_UNSUPPORTED_OPERATION` sin leer DAG local.
- `--as` sigue actor/auditoría. Auth y scopes de proyecto pertenecen al transporte/servidor.
- Todos los adapters y APIs soportados consultan la misma selección; APIs plugin/client no mapeadas se rechazan antes de cargar handlers locales.

## Enmienda de release

[ADR-027](027-minimal-remote-v1.md) concreta que el routing de todas las mutaciones built-in y `core.batch` pasa por un bridge único CLI/Application, no por checks repartidos en writers. Los adapters conservan parsing/envelopes; remoto despacha antes de policy/plugins/storage locales. `push`/`pull` permanecen excepciones tipadas sin journal/status. Query, plugin-data, extensiones, UI, snapshots y restore siguen rechazados remotamente antes de I/O local.

## Consecuencias

- A favor: un solo punto de decisión del backend, compatibilidad local y ausencia verificable de fallback.
- En contra / deuda: el routing de muchos commands debe migrarse por grupos; API de plugin remota tiene una superficie reducida en v1.

## Plan de implementación

1. Implementar selección/config y facade con errores/protocolo, conservando local por defecto; archivos: Application Operations, storage metadata y tests.
2. Enrutar lecturas read-model y verificar que no leen local; archivos: `src/cli/commands/*` read, dispatch y tests.
3. Enrutar mutaciones core/lifecycle/batch/init y respuestas unsupported para UI/plugins; archivos: `src/cli/commands/*`, plugins host/adapters, tests de dispatch.
4. Añadir tests adversariales de endpoint caído/401 con DAG local sentinel intacto (depende de ADR-022 y tasks previas).

## Onboarding breve para crear tasks

- [x] No hace falta: la matriz de commands está cerrada en RFC §Propuesta y la separación lectura/escritura evita ownership solapado.

## Verificación

- Cada lectura listada consulta servidor; con servidor inaccesible produce error remoto y nunca devuelve sentinel local.
- Cada mutación listada no modifica state local; operación no soportada devuelve código exacto sin I/O al DAG local.
- Sin `backend`, los tests de CLI existentes conservan sus contratos.
