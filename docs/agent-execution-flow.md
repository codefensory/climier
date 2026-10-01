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
    G --> H[climierflow status]
    H --> I{Hay checkpoint reanudable}
    I -->|Sí| J[climierflow resume task-id]
    I -->|No| K{La task debe comenzar de nuevo}
    K -->|Sí| L[climierflow restart task-id]
    K -->|No| M[Curar el DAG o corregir el contrato]
    J --> E
    L --> E
    M --> A

    F --> N{Corrección administrativa necesaria}
    N -->|No| O[Flujo completado]
    N -->|Sí| P[reopen, release o cancel según el caso]
    P --> A
```

La ejecución normal no se reproduce con secuencias manuales de `take`,
`submit`, `accept` o `reject`. Esas transiciones pertenecen al runner. Las
operaciones de Climier siguen disponibles para leer y curar el DAG y para
administración explícita; no sustituyen `climierflow run`, `status`, `resume` ni
`restart`.
