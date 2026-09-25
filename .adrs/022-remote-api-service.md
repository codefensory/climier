# ADR-022: API HTTP(S) tipada y autoridad del servidor remoto

- Gate: `G-remote-api-service` · Deriva de: `G-remote-backend-rfc` · Estado: propuesto
- Fecha: 2026-09-25

## Contexto

El RFC [G-remote-backend-rfc](../.decisions/G-remote-backend-rfc.md) selecciona un servidor Climier multi-proyecto accesible por HTTP(S), inicialmente probado sobre Tailscale. SSH solo habilita deployment/túnel; no es protocolo del cliente ni formato de storage. El servidor debe conservar la autoridad transaccional de kernel/providers y evitar que `project_id` controlado por el cliente se convierta en una ruta arbitraria.

## Decisión

- Definir una API de aplicación JSON versionada bajo `/v1`, con operaciones/read-models tipados. No exponer endpoints genéricos de archivo, filesystem ni `tasks.json`.
- El cliente autentica con bearer token obtenido de `CLIMIER_TOKEN` u otra fuente secreta local; `.climier.json` contiene solo `version`, `project_id` y `backend: { type: "remote", url }`. `--as` sigue siendo identidad de auditoría, no credencial.
- El servidor mantiene un catálogo confiable que autoriza `project_id` opacos y los resuelve a directorios generados/confinados bajo su data root. El cliente nunca elige ni concatena rutas. La autorización del token se verifica por proyecto antes de abrir storage.
- El servidor ejecuta las operaciones core permitidas con su propio kernel, providers, policies y storage; el cliente no puede enviar plugins/código ni cambiar políticas. Las mutaciones y el log pasan por el kernel server-side bajo lock.
- El servicio puede usar Node.js stdlib del CLI; no añade runtime dependencies al paquete raíz. TLS se ofrece directamente o se termina en proxy confiable; fuera de host local solo se acepta HTTPS.
- Un proyecto no provisionado solo se crea por `init` autorizado; desconocido/no autorizado retorna error estructurado sin crear state. El wire contract reporta versión/protocolo incompatible con error explícito.

## Consecuencias

- A favor: transporte cloud-portable, una autoridad por proyecto, aislamiento multi-tenant y reutilización del kernel.
- En contra / deuda: hay que operar catálogo, credenciales y servicio; la distribución/rotación de tokens queda en tooling de servidor.
- Las lecturas/mutaciones fuera del catálogo tipado (plugin query/data/extensiones) se rechazan en v1; nunca hay fallback local cuando el backend es remoto.

## Plan de implementación

1. Definir parser/config local y contratos JSON/protocolo; archivos: `src/storage/paths.mjs`, nuevo módulo de configuración/backend, tests de config/contrato.
2. Implementar catálogo confinado, auth por proyecto y rutas HTTP tipadas server-side; archivos: nuevo `src/server/` o subárbol de servicio, módulos de protocolo y tests de auth/aislamiento/concurrencia.
3. Conectar request remoto a operaciones core/read-models permitidos manteniendo la política server-side; archivos: Application Operations/transport adapter y tests de integración.

## Onboarding breve para crear tasks

- [x] No hace falta: los límites, autoridad y secuencia salen del contrato del RFC; tareas separan catálogo/servidor y cliente.

## Verificación

- Test de traversal/colisión y aislamiento de dos `project_id`; un ID no autorizado no crea ni abre archivos.
- Requests sin token, token sin scope y protocolo incompatible fallan con códigos estables antes de abrir storage.
- Mutaciones concurrentes ejecutan el kernel server-side; el segundo cliente observa cambios del primero.
- Inspección de dependencias confirma que el CLI raíz mantiene runtime stdlib-only.
