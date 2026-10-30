# Fase 9 — Flujo de HU con agente genérico (huAnalyst)

Prepara el flujo de trabajo para las etapas que necesita el usuario, empezando
por `huAnalyst` y su aprobación humana. Es un flujo INDEPENDIENTE del pipeline
develop/review; no se conecta todavía.

## Roles objetivo (visión completa — conceptual)

> Solo `huAnalyst` está implementado en esta fase. Los demás están definidos
> conceptualmente y NO se simulan como si existieran.

| Rol | Estado en Fase 9 | Responsabilidad |
| --- | --- | --- |
| `huAnalyst` | **Implementado** (Kiro CLI genérico) | Descompone una HU en tareas + criterios de aceptación; feedback y aprobación humana. |
| `technicalAnalyst` | Conceptual (no implementado) | Analiza el código, identifica archivos afectados, propone qué cambiar y dónde. |
| `develop` | Existe (pipeline separado) | Implementa siguiendo tareas + análisis técnico + criterios. |
| `functionalReview` | Conceptual | Valida cumplimiento de criterios de aceptación. |
| `qualityReview` | Conceptual | Clean Code, convenciones, arquitectura, directrices. |
| `finalApproval` | Conceptual | Revisión final humana del resultado. |
| `orchestrator` | Conceptual (fase posterior) | Recibe solicitudes/feedback, selecciona flujo, delega, decide desde qué etapa retomar. |

## Qué se implementó

### Esquema de HU (`src/hu/hu-schema.ts`)
`AnalyzedHu`: `summary`, `need`, `tasks[{order,description}]`,
`acceptanceCriteria[{id,description}]`, `assumptions[]`, `openQuestions[]`,
`dependencies[]`. `validateHu()` distingue válido de inválido y NUNCA "arregla"
ni acepta una HU incompleta (sin fallback).

### Agente genérico (`src/hu/hu-analyst.ts` + `hu-instructions.ts`)
- Reutiliza el rol `huAnalyst` del router (hoy `KiroCliAdapter`).
- Las instrucciones (prompt) están SEPARADAS del grafo, para poder
  especializarlas en el futuro sin tocar nodos.
- El agente es GENERICO: sin skills ni herramientas de empresa, sin framework.
- Pide la salida como JSON; `analyzeHu` la parsea y valida. Si Kiro falla, o la
  respuesta no es JSON, o no cumple el esquema → error EXPLÍCITO (sin fallback).
- `reviseHu()` regenera a partir de la versión previa + feedback humano.

### Flujo con aprobación humana (`src/hu/hu-graph.ts` + `hu-state.ts`)
```
START -> generateHuTask
  - fallo -> END (phase="failed")
  - ok -> approvalTask [interrupt(): revisión humana de la HU]
      - approve -> END (phase="approved", HU guardada)
      - reject  -> END (phase="rejected")
      - revise + feedback:
           - quedan revisiones -> generateHuTask (nueva versión con feedback)
           - sin cupo           -> END (phase="revision_limit")
```
- Decisiones: `{action:"approve"|"reject"|"revise", feedback?}`. Ausencia de
  respuesta NO aprueba (el grafo sigue pausado).
- Límite `MAX_HU_REVISIONS` (=2); al agotarlo, termina en `revision_limit`.
- Se conservan `versions[]` (historial de HUs) y `decisions[]` (historial de
  decisiones + feedback).
- Estado INDEPENDIENTE: no hay hash de propuesta ni escritura de archivos. Una
  HU aprobada queda en el estado persistido, lista para el analista técnico
  (fase futura).

### Compatibilidad / reutilización
- `AgentAdapter`, `AgentRouter` y checkpointer SQLite reutilizados.
- `AgentRole` += `"huAnalyst"` (opcional en `RoleAdapterMap`; el pipeline
  develop/review no lo necesita).
- El grafo NO está acoplado a nombres de CLI: habla con el rol `huAnalyst` vía
  router; cambiar Kiro por otra implementación no toca el grafo.

## Distinción importante

La aprobación de una HU (este flujo) NO es la autorización para modificar
archivos (pipeline develop→apply). Son flujos y aprobaciones separados.

## Pruebas (71 en total)

- `src/hu/hu-graph.test.ts` (8 casos): HU válida, inválida, fallo del agente,
  aprobar, revisar con feedback→nueva versión, rechazo, límite de revisiones,
  persistencia/reanudación con el mismo `thread_id`, sin aprobación no continúa.
- `src/hu/hu-schema.test.ts`: validador (válido/ inválido/ tipos).
- Deterministas, sin SSO ni llamadas reales; no tocan el repo.

## Limitaciones pendientes

- `huAnalyst` reutiliza Kiro genérico; no está especializado por framework ni
  empresa (a propósito).
- `technicalAnalyst`, `functionalReview`, `qualityReview`, `finalApproval` y
  `orchestrator` siguen sin implementar.
- El flujo de HU no está conectado al pipeline develop/review (a propósito).
- Integración real con Kiro: opt-in (no hay script manual de HU todavía; la
  validación real requeriría `kiro-cli login`).
