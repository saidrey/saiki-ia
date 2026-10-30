# saiki-ia — Contexto y reglas del proyecto

> Nombre oficial del proyecto: **`saiki-ia`**.

Orquestador personal de agentes IA con **LangGraph.js + TypeScript**. Se construye
por fases con KISS y sin sobreingeniería. Memoria completa en
`docs/PROJECT_MEMORY.md` (leer ese archivo al inicio de cada sesión).

**Fases completadas: 1 (grafo secuencial), 2 (rutas condicionales + límite),
3 (contrato `AgentAdapter`), 4 (Kiro CLI real en `analyze`), 5 (Claude Code real
en `develop`, modo PROPUESTA sin escritura), 6 (human-in-the-loop: aprobación
con interrupt antes de aplicar) , 7 (persistencia durable SQLite + idempotencia +
rollback best-effort) , 8 (revisión estructurada simulada + ciclo de corrección) y
9 (flujo de HU `huAnalyst` con aprobación humana) , 10 (analista técnico
`technicalAnalyst` genérico, solo lectura `fs_read`) , 11 (desarrollador Claude:
clasifica viabilidad y genera PROPUESTA trazable + hash; NO escribe/aplica) y
12 (revisiones automáticas funcional + calidad con Kiro, independientes, ambas
aprueban el MISMO hash; si Claude corrige se re-revisan ambas; límite global de
ciclos; NO aplica), 13 (aprobación humana FINAL + aplicación segura: reutiliza
el aplicador transaccional, aplica EXACTAMENTE la versión aprobada, verifica,
rollback best-effort honesto, idempotencia, auditoría) y 14 (FUNDAMENTOS
arquitectónicos: multi-runtime + capabilities, contrato del Moderador, Knowledge
Base compartida, rol `assistant`/OpenCode opcional, contratos de delegación y de
Jev; NO construye la experiencia conversacional ni Jev) y 15 (INTEGRACIÓN
extremo a extremo: `SaikiCore` cablea moderador→delegación/grafo→KB con los
componentes reales, implementa `JevCorePort`; sin Jev, sin LLM, sin RAG) y 16
(MODERADOR CONVERSACIONAL con LLM: `ConversationEngine` intercambiable +
`ClaudeConversationEngine`, `LlmModerator` async, integrado en `SaikiCore` sin
cambiar reglas de seguridad) y 17 (SÍNTESIS DE ASISTENCIA integrada: el Core
invoca automáticamente `synthesizeAssistance` tras una investigación exitosa,
con idempotencia y manejo de errores robusto) y 18 (AUDITORÍA del backend +
diseño de API, SOLO diagnóstico/diseño, sin código: ver `docs/BACKEND_AUDIT.md`).**
y 19 (API REST LOCAL sobre `SaikiCore` con http nativo en 127.0.0.1 +
`ExecutionView` + lock de aprobaciones por threadId + identidad local) y 20
(BUS DE EVENTOS + SSE: eventos de dominio reales derivados del estado observado,
EventBus aislado, EventStore SQLite con seq/Last-Event-ID, endpoint SSE
`/executions/:id/events`).** Mini-fase backend 21 (2026-10-30): resolución HTTP de las
puertas `hu_review` y `feasibility_partial` (`POST /executions/:id/approval/:kind`
+ `decisionHash`); verificada con tests y con un flujo real Kiro+Claude solo por
HTTP (ver `docs/PROJECT_MEMORY.md` §3.20). La Fase 21 (Jev, interfaz web en
`web/`) está COMPLETADA (2026-10-30, `docs/PROJECT_MEMORY.md` §3.21): sub-proyecto
independiente que solo consume REST + SSE vía proxy `/api`; no importar `src/`
desde `web/` ni lógica de orquestación en la UI. Mini-fase de estabilización
(2026-10-30, `docs/PROJECT_MEMORY.md` §3.22): una ejecución por solicitud (nunca
reutilizar el hilo de la sesión); `execution-lifecycle.ts` es la ÚNICA
clasificación de estado; `runGraph` es el único punto de entrada al grafo
(registra `activeRuns`); historial de propuestas/decisiones en `core.sqlite` es
solo inserción (triggers); el apagado cierra los streams SSE. Fase Project
Registry (2026-10-30, `docs/PROJECT_MEMORY.md` §3.23, `docs/ARCHITECTURE.md`
§10c): varios repositorios locales con aislamiento. Ver reglas abajo.

Backend como servicio (Fase 19). Doc: `docs/API.md`. Reglas: (a) la API es una
capa DELGADA sobre `SaikiCore`/`JevCorePort` (`src/api/http-server.ts`), http
NATIVO (sin Express); NO duplicar lógica ni persistencia. (b) Escucha SOLO en
127.0.0.1; la IDENTIDAD humana la fija el servidor (`humanActor`), NUNCA el body.
(c) Aprobaciones: `SaikiCore.resolveApproval` bajo `KeyedMutex` por threadId
(no global), verifica awaitingApproval + hash==pendiente; hash incorrecto → 409;
evita doble aplicación. (d) La API no tiene ruta directa al Safe Applier: solo
reanuda el grafo. (e) `ExecutionView` (`src/core/execution-view.ts`) proyecta
HuState sin exponerlo, honesta (available/unavailable/not_applicable), campo
`events?` reservado para F20. `npm run serve` arranca local; el modo de
aplicación es POR PROYECTO (`SAIKI_APPLY_TO_REAL_REPO` ya no tiene efecto).
- Eventos + SSE (Fase 20). Doc: `docs/EVENTS.md`. Reglas: (a) eventos REALES
  derivados del estado observado (`ExecutionView` diff para `stage.*`); NO
  instrumentar el grafo ni inventar etapas (en la pausa de la HU no hay
  stage.started). (b) `EventBus` (`src/events/event-bus.ts`) AÍSLA a los
  suscriptores: un throw no detiene el Core ni a otros. (c) `EventStore`
  (`src/events/event-store.ts`, better-sqlite3) asigna `seq` por ejecución =
  Last-Event-ID; `getSince` para reconexión; retención por ejecución. (d) El Core
  emite en puntos reales (process/submitApproval/resolveApproval/proposeKnowledge)
  y es IDEMPOTENTE al reanudar (lastStageStatus). (e) Endpoint SSE
  `GET /executions/:id/events` (text/event-stream, Last-Event-ID, heartbeat,
  cierre limpio que NO interrumpe la ejecución). eventBus/eventStore son
  OPCIONALES en SaikiCore/createApiServer (si faltan, no se emite/501). No
  WebSocket. Plan: F21 Jev (frontend).
- Puertas de decisión por HTTP (mini-fase backend 21). Doc: `docs/API.md` §5.1.
  Reglas: (a) `SaikiCore.resolveGate` reutiliza el MISMO `KeyedMutex`,
  `submitApproval` y la auditoría (`recordHumanDecision`) de `resolveApproval`;
  no duplicar lógica. (b) Solo se acepta si el grafo está PAUSADO en esa puerta
  (interrupt real leído de `getState().tasks[].interrupts`), no si es solo el
  "siguiente nodo". (c) `decisionHash` = SHA-256 derivado del checkpoint
  (`hashHuReview` con nº de versión; `hashFeasibilityDecision`), sin estado nuevo
  en el grafo. (d) `submitApproval` traduce la decisión por puerta (HU:
  request_changes→revise; viabilidad: approve→proceed) y RECHAZA las no
  admitidas (antes se tomaban en silencio como rechazo). Viabilidad parcial NO
  tiene request_changes (400 `unsupported_decision`): no inventar ruta. (e)
  `POST /executions/:id/approval` (propuesta, `proposalHash`) intacto; los
  cambios de contrato son aditivos (`gate`, `decisionHash`, `kind`).
- Registro de proyectos (fase Project Registry). Doc: `docs/API.md` §5.3,
  `docs/ARCHITECTURE.md` §10c, `docs/PROJECT_REGISTRY_PROPOSAL.md` (D1–D9).
  Reglas: (a) solo el humano administra el registro vía API (`JevProjectPort`);
  NUNCA darle acceso a agentes, moderador ni grafo. (b) Un proyecto es la raíz
  de un repo git; ruta `realpath` e identidad INMUTABLES (trigger); sin borrado.
  (c) El proyecto de una sesión no se reasigna (trigger). (d) Cada ejecución nace
  atada a una copia del proyecto en `HuState.project` (reducer keep-first) y en
  `execution_projects` (solo inserción); nunca leer una ruta global en los nodos:
  el Core construye el grafo con `requireProject: true`. (e) Todo agente recibe
  `context.workingDirectory` → `spawn({ cwd })`; moderador y sesiones generales,
  directorio vacío temporal (nunca el del backend). (f) Escribir SOLO tras la
  guardia (`src/projects/apply-guard.ts`): sin fallback de ruta; sandbox propio
  por ejecución salvo modo `real` al vincular Y ahora. (g) Ejecuciones sin
  proyecto: solo `reject` (`409 project_unbound`). (h) Riesgo residual
  documentado: `fs_read` de Kiro no está confinado (solo lectura).

## Rol esperado
Actuar como desarrollador senior **y tutor técnico**: explicar qué se hizo y por
qué, y decir al usuario explícitamente **qué probar y cómo**. Responder en español.

## Cierre de cada fase (obligatorio)
Al terminar una fase, SIEMPRE entregar, además del resumen técnico:
1. Un **mensaje corto para el PO** (lenguaje de producto, no técnico; sin
   comandos): qué se logró, qué garantiza y su alcance.
2. La **decisión concreta que el PO debe tomar para continuar** (la pregunta
   explícita de alcance de la siguiente fase, con opciones si aplica).

## Reglas duras (no romper sin confirmación explícita del usuario)
- NO avanzar de fase sin que el usuario lo confirme.
- NO modificar configuraciones globales del entorno del usuario.
- NO usar Engram ni memoria semántica todavía (el usuario lo pidió).
- NO añadir: frontend, servidor HTTP/WebSocket, Godot, agente real para review
  (analyze=Kiro y develop=Claude ya hechos), ESCRITURA REAL de las propuestas de
  develop, bases de datos, human-in-the-loop.
- NO añadir dependencias innecesarias. Preferir ajustar versiones a forzar instalaciones.

## Entorno
- Runtime: **Node 22 vía nvm** (`nvm use 22` en la terminal). El default global del
  usuario es Node 20 y **no se toca**.
- El npm global apunta a un JFrog corporativo; este proyecto usa un `.npmrc` local
  con el registry público. No borrar ese `.npmrc`.
- Kiro CLI (rol analyze): auth por **login SSO interactivo** (`kiro-cli login`).
  API key headless BLOQUEADA por la organización SSO corporativa; no reintentar sin confirmación.
- Claude Code (rol develop): modo PROPUESTA sin escritura. Flags verificados:
  `-p --tools "" --restricted --strict-mcp-config --disallowedTools Write Edit
  Bash`. El prompt va por STDIN (los flags variádicos se comen un arg posicional).
- `npm test` y `npm start` NUNCA llaman a CLIs reales (router solo-mock). La
  integración real es opt-in: `npm run manual:kiro` y `npm run manual:claude`.
- Human-in-the-loop (Fase 6): el grafo PAUSA con `interrupt()` antes de aplicar
  cambios. `buildGraph({router?,checkpointer?,rootDir?})` + checkpointer
  (MemorySaver) + `invoke(..., {configurable:{thread_id}})`. Reanudar con
  `Command({resume:{action:"approve"|"reject"}})`. Ausencia NO aprueba.
- Aplicación de cambios: SOLO vía `src/apply/transactional-applier.ts` (código
  nuestro, NO el modelo). Atada a hash (lo aprobado==lo aplicado), validación de
  rutas (anti absoluta/traversal/symlink), detección de conflicto. Claude NUNCA
  escribe. Rechazo = repo intacto.
- Persistencia (Fase 7): checkpointer SQLite (`src/persistence/checkpointer.ts`)
  durable entre reinicios. Default `.saiki/checkpoints.sqlite` (gitignored). Los
  TESTS deben inyectar `createMemoryCheckpointer()` o SQLite temporal, NUNCA el
  default (tocaría el repo y compartiría estado).
- Idempotencia: `appliedHash` en el estado; aplicar el mismo hash dos veces es
  `noop`. Rollback best-effort (NO transaccional): si la restauración falla, se
  REPORTA `unrecoverable`, no se finge éxito.
- Flujo de HU (Fase 9, `src/hu/`): INDEPENDIENTE del pipeline develop/review.
  `buildHuGraph({router,checkpointer})`. Rol `huAnalyst` (Kiro genérico) produce
  una `AnalyzedHu` validada por esquema (`validateHu`, sin fallback). Aprobación
  humana con interrupt: approve/reject/revise+feedback; límite `MAX_HU_REVISIONS`;
  ausencia NO aprueba. Instrucciones separadas del grafo (`hu-instructions.ts`).
  La aprobación de una HU NO es autorización para escribir archivos.
- Analista técnico (Fase 10, `src/tech/`): rol `technicalAnalyst` = Kiro CLI con
  SOLO LECTURA `--trust-tools=fs_read` (verificado contra `kiro-cli --help`;
  nunca escritura/ejecución). Corre tras aprobar la HU (nodo
  `technicalAnalysisTask`, terminal). `validateTechnicalAnalysis` VERIFICA rutas
  en disco y reporta `unresolvedPaths` (no inventa). HU rechazada no llega.
  `KiroCliAdapter` acepta `trustTools` configurable (default "").
- Desarrollador (Fase 11, `src/dev/`): tras tech, `classifyFeasibility` deriva
  ready/blocked/partially_ready del CONTENIDO del análisis. ready→Claude genera
  `DevProposal` validada + hash; blocked→detiene (no ejecuta Claude);
  partially_ready→decisión humana (interrupt). `devApprovalGate` (interrupt
  approve/reject) es TERMINAL: en Fase 11 NO se aplican cambios. Claude NO
  escribe (verificado). `ClaudeCliAdapter({rawPrompt:true})` para el flujo HU.
  Claude no puede saltarse decisiones humanas.
- Revisiones automáticas (Fase 12, `src/reviewers/`): functionalReviewer y
  qualityReviewer (Kiro fs_read, independientes). Flujo: develop→funcReview→
  (rechazo:develop / aprobado:qualReview); qualReview rechazo→develop→RE-REVISA
  AMBAS. INVARIANTE: aprobación humana solo si functionalApprovedHash==
  qualityApprovedHash==devProposalHash. Claude al corregir genera hash nuevo y
  develop VACÍA ambos hashes (invalida aprobaciones). MAX_REVIEW_CYCLES=3 global;
  agotar NO auto-aprueba (reviews_exhausted). Revisores no escriben; no aplican.
- Aprobación final + aplicación (Fase 13, `src/apply/`): tras reviews_passed,
  `finalApprovalTask` (interrupt approve/reject/request_changes; ausencia NO
  aprueba) → `applyTask` → `verifyTask`. Doc: `docs/APPLY.md`. Reglas duras:
  (a) REUTILIZAR `applyProposalTransactional` (Fase 7); NO crear otro aplicador.
  Se extendió con operación `delete` (`FileOperation=create|update|delete`).
  (b) Puente `src/apply/dev-proposal-bridge.ts` (`applyDevProposal`): verifica
  `hashDevProposal===approvedDevHash` antes de escribir; idempotencia por
  `appliedHash` (noop); convierte modify→update, delete→delete. (c) applyTask
  recalcula el hash y compara con `finalApprovedHash`; si no coincide →
  `apply_blocked`. Una aprobación NUNCA vale para otra versión. (d) request_changes
  vuelve a develop e invalida TODAS las aprobaciones. (e) Rollback best-effort,
  NO atómico: `rolled_back` (revertido) vs `unrecoverable` (no se finge éxito).
  (f) Verificación posterior (`verify-applied.ts`) compara disco vs propuesta;
  mismatch → `unrecoverable`. Checks del proyecto (tests/typecheck) OPT-IN
  (`runChecks`) → `applied_with_test_failures`. (g) `buildHuGraph` acepta
  `applyDir` (default rootDir); el manual aplica en COPIA TEMPORAL por defecto y
  exige DOBLE autorización (`SAIKI_APPLY_TO_REAL_REPO=1` + escribir "APLICAR EN
  REAL") para tocar el repo real. Estados Fase 13: awaiting_final_approval,
  final_approval_rejected, ready_to_apply, applying, applied,
  applied_with_test_failures, rolled_back, unrecoverable, apply_blocked.
- Arquitectura multiagente (Fase 14). Doc: `docs/ARCHITECTURE.md`. Reglas:
  (a) ROL != RUNTIME. Un rol (developer, technicalAnalyst, assistant) es una
  responsabilidad; Kiro/Claude/OpenCode son runtimes intercambiables. No acoplar
  roles a proveedores. (b) `AgentAdapter` y `forRole` INTACTOS; no migrar
  adaptadores existentes. `MapAgentRouter` admite mapa runtime→adaptador opcional
  (`RuntimeAwareRouter`). (c) OpenCode (`src/agents/opencode-cli-agent.ts`) es
  runtime OPCIONAL, solo lectura, verificado (`opencode run --format json
  --agent`; SIN `--auto`); `createDefaultRuntimeRegistry({includeOptional:false})`
  lo omite sin romper nada. (d) Capacidades (`src/agents/capabilities.ts`) por
  TAREA, no por runtime; `apply_changes` solo lo ejerce el Safe Applier; agentes
  auxiliares no heredan escritura. `checkPermissions` ANTES de ejecutar. (e)
  Moderador (`src/moderator/`) solo CONTRATO+estado en esta fase; determinista;
  pregunta técnica NO inicia desarrollo; escala solo con autorización explícita;
  no salta aprobaciones ni ejecuta el applier; un resultado de agente NUNCA es
  decisión aprobada. (f) Knowledge Base (`src/knowledge/`, SQLite better-sqlite3,
  sin deps nuevas): estados proposed/approved/superseded/archived; `approve()`
  EXIGE actor humano (agentes lanzan); superseded conserva historial. (g) Jev
  (`src/core/jev-contracts.ts`): SOLO contratos; sin frontend/WS/voz; Jev no
  ejecuta agentes ni contiene lógica de aprobación. NO construir Jev sin OK.
- Integración extremo a extremo (Fase 15). Doc: `docs/INTEGRATION.md`. El punto
  de entrada es `src/core/saiki-core.ts` (`SaikiCore implements JevCorePort`):
  `process(sessionId, message)` clasifica con el moderador y enruta a
  conversation/assistance/development. Reglas: (a) development → `buildHuGraph`
  (NO reimplementar el grafo); las aprobaciones humanas se transmiten con
  `submitApproval` (`Command resume`), NUNCA se saltan. (b) assistance → tarea
  SOLO LECTURA vía `runDelegatedTask` (OpenCode); jamás `apply_changes`. (c) El
  Core NO escribe el repo por ningún camino: solo el grafo→Safe Applier. (d)
  `CoreStore` (`src/core/core-store.ts`, SQLite) persiste sesiones+tareas sin
  duplicar el estado de LangGraph. (e) Conocimiento oficial exige actor humano.
  Reutilizar `SaikiCore` como punto de integración; no crear otro Core.
- Moderador conversacional (Fase 16). Doc: `docs/MODERATOR.md`. Reglas: (a) el
  moderador es INDEPENDIENTE del proveedor: depende de `ConversationEngine`
  (`src/moderator/conversation-engine.ts`); cambiar de proveedor = otro engine,
  SIN tocar el Core. `ClaudeConversationEngine` reutiliza `ProcessRunner` en modo
  SOLO TEXTO (separado del rol develop). (b) `LlmModerator` (AsyncModerator)
  clasifica con JSON tipado validado; fallo/JSON inválido → `ModeratorEngineError`
  explícito (NUNCA simular salida). (c) La CONFIANZA del modelo NO autoriza
  acciones sensibles. (d) El moderador NO escribe/aplica/aprueba (código ni KB)
  ni salta aprobaciones: solo clasifica y redacta; el Core ejecuta. (e) El Core
  acepta `Moderator | AsyncModerator` sin cambiar reglas; categoría nueva
  `clarification` pregunta y NO ejecuta. Mantener el `BasicModerator` síncrono
  como fallback determinista.
- Síntesis de asistencia (Fase 17). Doc: `docs/ASSISTANCE.md`. Tras una tarea de
  asistencia con éxito, `SaikiCore` llama a `trySynthesize` → si el moderador
  soporta `AssistanceSynthesizer` (type-guard `canSynthesize`), sintetiza; si no,
  entrega el crudo con nota. Reglas: (a) investigación fallida → error explícito,
  NUNCA síntesis ni falso éxito. (b) Síntesis fallida → se CONSERVA el resultado
  crudo (no se pierde). (c) Idempotencia: `DelegatedTask.synthesis?` persistido;
  una ejecución recuperada NO re-sintetiza. (d) La síntesis NO inventa: parte
  solo de `task.result`. Contratos ampliados de forma ADITIVA (AssistanceSynthesizer,
  synthesis?); no se tocaron contratos fundamentales ni la seguridad.
- Revisión (Fase 8, `src/review/`, pipeline VIEJO distinto del flujo de HU):
  aislado del grafo e inyectable en `buildGraph({ reviewer })`. Contrato
  `ReviewResult {status, decision, findings, summary}`: `status:failure` ≠
  `decision:rejected`; inválido NUNCA es aprobación. Flujo: review va ANTES de
  la aprobación humana. Rechazo → develop con hallazgos (hash nuevo, nueva
  aprobación). Límite `MAX_CORRECTIONS` → rechazo definitivo. El revisor es un
  mock determinista honesto (no finge IA).

## Convenciones de código (LangGraph)
- Estado con `Annotation.Root`. Campos del estado = **sustantivos** (datos).
- Nodos = **verbos** con sufijo `Task` (p. ej. `reviewTask`). Un nodo NO puede
  llamarse igual que un campo del estado (colisión de namespace en LangGraph).
- Cada nodo lee el estado completo y devuelve SOLO el delta (las claves que cambia).
- Usar la API moderna: `addEdge(START, ...)` / `addEdge(..., END)` y `compile()`.
  Evitar `setEntryPoint`/`setFinishPoint` (API pre-1.0 desaconsejada).
- Rutas condicionales con `addConditionalEdges(origen, fnRuteo, mapa)`. La función
  de ruteo solo LEE el estado y devuelve un string; no lo modifica.
- Enrutar por campos booleanos dedicados (p. ej. `approved`), NO parseando texto.
- Para contar/acumular entre pasadas de un bucle, usar un REDUCER en el canal
  (p. ej. `attempts` con `(cur, delta) => cur + delta`). Last-write-wins pisa.
- Los bucles deben cortar con un contador explícito vs. un límite fijo
  (`MAX_CORRECTIONS`), NO depender del `recursionLimit` de LangGraph.
- Agentes: los nodos dependen de la abstracción `AgentAdapter` (en
  `src/agents/types.ts`), NUNCA de Kiro/Claude/Codex directamente. Un agente
  nuevo = una clase que implementa el contrato; no se tocan nodos ni grafo.
- El reparto por rol lo hace un `AgentRouter` (`src/agents/router.ts`), que se
  INYECTA en `buildGraph(router)`. Las fábricas `make*` reciben el router y
  piden el adaptador de su rol. Único lugar que sabe "quién ejecuta qué".
- Los agentes reportan fallos devolviendo `AgentResult { status: "failure", error }`,
  NO lanzando excepciones.
- Integrar una CLI real: aislar el `spawn` detrás de un `ProcessRunner`
  inyectable (`src/agents/process-runner.ts`) para tests deterministas. `spawn`
  sin shell + args como array; timeout; tope de bytes de salida; permisos
  mínimos (analyze usa `--trust-tools=read`, nunca `--trust-all-tools`).
- Un fallo de agente real debe enrutar a una ruta de FALLO EXPLÍCITA; nunca
  hacer fallback silencioso al mock.

## Verificación estándar tras cambios
`npm run typecheck` · `npm start` · `npm test` (recordar `nvm use 22` antes).
