# ADR-026: operación del servidor y prueba E2E remota

- Gate: `G-remote-server-operations` · Deriva de: `G-remote-backend-rfc` · Estado: aprobado
- Fecha: 2026-09-25

## Contexto

La primera prueba usará una máquina Linux alcanzable por Tailscale del usuario. El producto debe seguir siendo portable a cloud: transporte HTTPS/API, sin hostname/IP/secret versionado ni dependencia del SSH agent. El CLI raíz no debe agregar runtime dependencies.

## Decisión

- Empaquetar un servicio Climier Node con configuración de operador para data root, catálogo, auth y bind address; exponer HTTP(S) API versionada. HTTPS puede terminar en proxy documentado, pero la escucha de servicio se mantiene privada/local salvo deployment explícito seguro.
- SSH agent solo instala/administra servicio o abre túnel temporal de prueba. El cliente Climier usa API HTTP(S) normal sobre endpoint configurable en `.climier.json`.
- Proveer runbook de instalación, inicialización/provisioning de proyecto/token, backups, restart y recuperación de `.lock` stale (verificar PID/host antes de borrarlo); nunca incluir secretos/hosts/IPs tailnet en repo.
- La aceptación E2E usa dos clientes independientes sobre tailnet: mutación en cliente A visible vía read en B; archivos DAG locales permanecen sin cambios; token inválido y caída del endpoint fallan sin fallback.
- Mantener CLI package raíz stdlib-only; cualquier necesidad de dependencias del servicio debe tener distribución separada y no filtrarse al CLI.

## Consecuencias

- A favor: experiencia inicial reproducible y ruta cloud-compatible, sin fijar la infraestructura del usuario.
- En contra / deuda: requiere operación segura de servicio, TLS, tokens y backups; una prueba real requiere acceso/configuración de host que no se versiona.

## Plan de implementación

1. Definir entry point/configuración y ciclo de vida del server; archivos: `bin/`, nuevo server/config, package scripts/docs.
2. Escribir runbook genérico y checklist E2E, con slots para valores locales no versionados; archivos: `docs/remote-server.md` y scripts de prueba.
3. Ejecutar E2E en dos clientes Tailscale y documentar transcript redactado (depende de ADR-022, ADR-024 y ADR-025).

## Onboarding breve para crear tasks

- [x] No hace falta: entorno de host es variable de operador y el acceptance evita secretos/versionados.

## Verificación

- Runbook puede instalar/arrancar/consultar/detener el server en Linux limpio con Node soportado.
- E2E de dos clientes demuestra visibilidad cruzada y ausencia de cambios locales; 401/desconexión nunca usa local.
- Git grep de hostnames, IP tailnet y credenciales no encuentra valores reales; paquete root conserva runtime dependency set actual.
