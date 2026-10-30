# Fase 15 — Integración extremo a extremo

> Nombre oficial: `saiki-ia`. Esta fase CONECTA los componentes de fases
> anteriores en un flujo funcional, sin reimplementarlos y sin debilitar la
> seguridad del flujo de desarrollo.

## 1. Diagnóstico previo (antes de integrar)

Lo que YA funcionaba (real, probado):
- Grafo de desarrollo completo (`buildHuGraph`): HU → técnico → viabilidad →
  develop → revisiones → aprobación final → aplicación segura. Reanudable por
  `thread_id` (SQLite).
- `BasicModerator` (clasificación determinista), `runDelegatedTask` (delegación
  con validación de permisos), `KnowledgeStore` (KB persistente con estados).
- Adaptadores Kiro/Claude/OpenCode + router rol/runtime + capacidades.

Lo que eran SOLO contratos (no cableados):
- `JevCorePort`: interfaz sin implementación.
- No existía un **Core** que uniera moderador + delegación + grafo + KB en un
  único punto de entrada.
- La `DelegatedTask` de asistencia no se construía en ningún lado (el contrato
  del moderador la delega al "Core/integrador con el grant adecuado").

Conclusión: los contratos de Fase 14 eran SUFICIENTES. No se necesitaron cambios
arquitectónicos. El único trabajo fue cablear (`SaikiCore`) y persistir
(`CoreStore`). **No se modificó ningún contrato existente.**

## 2. Flujo extremo a extremo

```
  Usuario
    │  mensaje
    ▼
┌──────────────┐   classify()      ┌──────────────────────────────────────────┐
│  Moderador   │ ────────────────► │  conversation | assistance | development  │
│ (determinista)│                   └──────────────────────────────────────────┘
└──────────────┘                                   │
    │ decisión                                      │
    ▼                                               ▼
┌──────────────────────────  SaikiCore (JevCorePort)  ───────────────────────────┐
│                                                                                 │
│  conversation ─► responde (reply), consulta KB opcional. NO inicia desarrollo.  │
│                                                                                 │
│  assistance   ─► DelegatedTask (SOLO LECTURA) ─► runDelegatedTask ─► OpenCode   │
│                  (valida permisos ANTES; nunca apply_changes; resultado = dato) │
│                                                                                 │
│  development  ─► buildHuGraph.invoke({request}, thread_id)                       │
│                  └─ HU → técnico → develop → revisiones → APROBACIÓN HUMANA →   │
│                     Safe Applier (único que escribe el repo)                    │
│                                                                                 │
│  Knowledge Base: proposeKnowledge() (proposed) · searchKnowledge() ·            │
│                  requestKnowledgeApproval(humanActor) → approved                │
│                                                                                 │
│  Persistencia: CoreStore (sesiones+tareas) + checkpointer LangGraph (flujos)    │
└─────────────────────────────────────────────────────────────────────────────────┘
    │ submitApproval(threadId, approve|reject|request_changes)
    ▼
  reanuda el grafo (Command resume) → aplica vía Safe Applier si se aprueba
```

## 3. Componentes conectados

| Camino | Entrada | Componente real usado | Resultado |
|--------|---------|------------------------|-----------|
| Conversación | pregunta técnica | `BasicModerator` | respuesta; NO desarrollo |
| Asistencia | investigar/redactar | `runDelegatedTask` + OpenCode (solo lectura) | resultado como dato |
| Desarrollo | implementar/crear | `buildHuGraph` (grafo completo) | flujo pausado en aprobación |
| Aprobación | decisión humana | `submitApproval` → `Command resume` | aplica vía Safe Applier |
| Memoria | consultar/registrar | `KnowledgeStore` | proposed → (humano) → approved |

`SaikiCore` implementa `JevCorePort`: la misma fachada que una futura interfaz
(Jev) usaría. No se construyó Jev.

## 4. Garantías de seguridad (no debilitadas)

- El flujo de desarrollo conserva las aprobaciones humanas (interrupts del
  grafo). `SaikiCore` NO las salta: solo las transmite con `submitApproval`.
- La aplicación de cambios ocurre SOLO vía el Safe Applier, dentro del grafo.
  `SaikiCore` no expone ningún método que escriba el repositorio.
- Las tareas de asistencia se ejecutan con permisos de SOLO LECTURA
  (`read_repo`, `read_kb`, `external_docs`); nunca `apply_changes` (el runner lo
  bloquea).
- Promover conocimiento a oficial exige actor HUMANO (lo impone la KB). Un
  agente que intente aprobar provoca un error.
- Los errores de runtime se comunican explícitamente: una tarea fallida queda
  `failed` con el error y SIN `result` (no hay falso éxito).

## 5. Persistencia y continuidad

- `CoreStore` (SQLite): sesiones del moderador y tareas delegadas. NO duplica el
  estado de LangGraph: la sesión REFERENCIA el flujo por `developmentThreadId`.
- Los flujos de desarrollo persisten en el checkpointer de LangGraph.
- Recuperación: con los mismos archivos SQLite, un nuevo `SaikiCore` recupera la
  sesión y el flujo pausado (probado en los tests).
- Idempotencia de aplicación: heredada de Fase 13 (no se aplica dos veces el
  mismo hash).

## 6. Pruebas

`src/core/saiki-core.test.ts` (9 tests deterministas, dobles sin CLIs reales):

1. Una solicitud de desarrollo llega al grafo y conserva sus aprobaciones.
2. Una consulta técnica NO inicia desarrollo.
3. Una investigación usa OpenCode sin modificar el repositorio.
4. El conocimiento aprobado puede consultarse desde una ejecución.
5. El conocimiento nuevo queda como propuesta hasta aprobación humana.
6. Una ejecución interrumpida se recupera sin perder su estado (SQLite real).
7. Un error de runtime se comunica explícitamente (sin falso éxito).
8. Ningún camino de integración omite el Safe Applier ni las aprobaciones.
+ End-to-end: desarrollo aprobado aplica vía el grafo/applier.

Las fases 1-14 siguen verdes (suite completa: 180 tests en 23 archivos).

## 7. Demostración manual (opt-in)

`npm run manual:e2e` ejecuta la integración con los COMPONENTES REALES
(`src/manual/e2e-integration.ts`), recorriendo conversación, asistencia,
desarrollo y Knowledge Base sobre un único `SaikiCore`. La aplicación de cambios
se dirige por defecto a una COPIA TEMPORAL del repo; tocar el repo real exige
`SAIKI_APPLY_TO_REAL_REPO=1` (protección de Fase 13).

## 8. Limitaciones / pendientes

- El moderador sigue siendo determinista (sin LLM): es lo acordado para esta
  fase. La inteligencia conversacional es la Fase 16.
- Jev no se construyó (solo la fachada `JevCorePort`, ya implementada por el Core).
- La relación "solicitud ↔ ejecución ↔ conocimiento generado" se registra a
  nivel de sesión (turnos, `delegatedTaskIds`, `developmentThreadId`); no hay un
  grafo de relaciones más rico todavía (no se necesitaba).
- Recuperación semántica de la KB: preparada, no implementada (sin vectores/RAG).

## 9. Archivos de esta fase

- `src/core/saiki-core.ts` — Core de integración (implementa `JevCorePort`).
- `src/core/core-store.ts` — persistencia de sesiones y tareas (SQLite).
- `src/core/saiki-core.test.ts` — 8 escenarios de aceptación + end-to-end.
- `src/manual/e2e-integration.ts` — demo manual opt-in (`npm run manual:e2e`).
