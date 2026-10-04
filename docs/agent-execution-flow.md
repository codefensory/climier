# Flujo de ejecución de tasks

Climier mantiene el DAG y sus contratos. `climierflow` es el único entrypoint
operativo para ejecutar una task: posee internamente claim, worktree,
implementación, revisión, lifecycle, commit, merge y limpieza.

```mermaid
graph TD
    A[Leer status y context de la task] --> B{Contrato listo y task ready}
    B -->|No| C[Curar el DAG con update, add-note o resolve]
    C --> A
    B -->|Sí| D[climierflow run task-id]
    D --> E{Resultado terminal JSON}

    E -->|Éxito| F[Conservar summary, commit y merged]
    E -->|Bloqueo o fallo| G[Leer error code, message y details]
    G --> H[climierflow status T-auth-7]
    H --> I{Hay checkpoint reanudable}
    I -->|Sí| J[climierflow resume T-auth-7 --summary TEXT opcional]
    I -->|No| K{La task no completó el intento}
    K -->|Sí| L[climierflow restart T-auth-7 --body replacement --acceptance replacement --confirm-discard]
    K -->|No| M[Crear una nueva task de corrección]
    J --> E
    L --> E
    M --> A

    F --> N{¿Corrección administrativa del DAG?}
    N -->|No| O[Flujo completado]
    N -->|Sí| P[Usar reopen, release o cancel según el estado]
    P --> A
```

Las formas concretas de recuperación son:

```bash
climierflow status <task-id>
climierflow resume <task-id> [--summary TEXT]
climierflow restart <task-id> --body "<replacement body>" --acceptance "<replacement acceptance>" --confirm-discard
```

`--summary` es opcional para `resume`. `restart` exige valores de reemplazo
para `--body` y `--acceptance`, además de `--confirm-discard`. Si el intento ya
está completado y mergeado, el runner devuelve `RESTART_REQUIRES_REVIEW`: no se
debe hacer `reopen` y restart del flujo completado; el trabajo adicional va en
una nueva task de corrección.

La ejecución normal no se reproduce con secuencias manuales de `take`,
`submit`, `accept` o `reject`. Esas transiciones pertenecen al runner. Las
operaciones de Climier siguen disponibles para leer y curar el DAG y para
administración explícita; no sustituyen `climierflow run`, `status`, `resume` ni
`restart`.
