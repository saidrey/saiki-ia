# Handoff técnico — Frontend (Jev) de Saiki-IA

> **Para:** Claude Code (implementador del frontend).
> **De:** arquitectura de Saiki-IA (Fase 21).
> **Alcance:** construir un dashboard web de supervisión que consuma la API REST
> (Fase 19) y SSE (Fase 20). **NO modificar el backend.** La API es la única
> fuente de verdad.
>
> Convención de este documento:
> - ✅ **EXISTE** — verificado en el código actual (ruta citada).
> - ⚠️ **LIMITACIÓN** — algo que el backend NO ofrece hoy; no lo inventes.
> - 💡 **PROPUESTA** — recomendación de arquitectura frontend (puedes ajustarla).

---

## 1. Contexto del proyecto

Saiki-IA es un orquestador personal de agentes de IA (LangGraph.js + TypeScript)
construido por fases. El flujo de desarrollo es: HU → análisis técnico →
viabilidad → desarrollo (propuesta de Claude) → revisión funcional → revisión de
calidad → **aprobación humana** → aplicación segura (Safe Applier). Además hay un
**moderador conversacional** que clasifica mensajes en `conversation`,
`assistance`, `development` o `clarification`, un **asistente** (OpenCode, solo
lectura) y una **Knowledge Base**.

El backend ya expone:
- ✅ **API REST local** (Fase 19) — `docs/API.md`.
- ✅ **Eventos de dominio + SSE** (Fase 20) — `docs/EVENTS.md`.

Jev es SOLO la interfaz: no contiene lógica de negocio.

---

## 2. Arquitectura real del backend

- ✅ Punto de integración: clase `SaikiCore` (`src/core/saiki-core.ts`), implementa
  `JevCorePort` (`src/core/jev-contracts.ts`).
- ✅ Servidor HTTP: `src/api/http-server.ts` (`createApiServer`), módulo `http`
  NATIVO de Node (sin Express). Arranque: `src/api/serve.ts` (`npm run serve`).
- ✅ Estado de ejecución: proyectado a `ExecutionView` (`src/core/execution-view.ts`),
  NO se expone el estado interno del grafo.
- ✅ Eventos: `src/events/` (`event-types.ts`, `event-bus.ts`, `event-store.ts`).
- ✅ Persistencia: SQLite en `.saiki/` (checkpoints, core, knowledge, events).
- ✅ Stack: TypeScript + ESM, ejecutado con `tsx`. Dependencias de producción
  mínimas (solo LangGraph). Tests con `vitest`.

⚠️ **No hay dependencias de frontend ni build web en el repo.** El frontend es un
sub-proyecto nuevo e independiente (ver §10).

---

## 3. Endpoints REST verificados

Base URL por defecto: `http://127.0.0.1:4123` (puerto `SAIKI_API_PORT`, default
4123; host fijo `127.0.0.1`). Todas las respuestas son JSON
(`content-type: application/json; charset=utf-8`).
Fuente: `src/api/http-server.ts` → `buildRoutes`.

### Salud
- ✅ `GET /health` → `200 { "ok": true }`

### Sesiones
- ✅ `POST /sessions` — body `{ "sessionId"?: string }` → `201 { sessionId, existed }`.
  Si no envías `sessionId`, el servidor genera uno.
- ✅ `GET /sessions` → `200 { sessions: ModeratorSession[] }`
- ✅ `GET /sessions/:id` → `200 { session: ModeratorSession, tasks: DelegatedTask[] }`
  (404 si no existe)
- ✅ `POST /sessions/:id/messages` — body `{ "message": string }` (no vacío) →
  `200 { result: HandleResult }`. 400 si falta `message`.

### Ejecuciones (flujo de desarrollo)
- ✅ `GET /executions/:threadId` → `200 { execution: ExecutionView }` (404 si no existe)
- ✅ `GET /executions/:threadId/stages` → `200 { executionId, currentStage, stages: ExecutionStage[] }`
- ✅ `GET /executions/:threadId/result` → `200 { executionId, status, finalResult: FinalResultView }`

### Aprobaciones
- ✅ `GET /executions/:threadId/approval` →
  `200 { pendingApproval: PendingApprovalView, proposal: ProposalView | null }`
  (`proposal` es `null` si no hay aprobación requerida; 404 si la ejecución no existe)
- ✅ `POST /executions/:threadId/approval` — body
  `{ "decision": "approve"|"reject"|"request_changes", "proposalHash": string, "feedback"?: string }`
  → `200 { resolution: ApprovalResolution }`.
  - 400 si `decision` inválida o falta `proposalHash`.
  - 409 `hash_mismatch` si el hash no coincide con la propuesta pendiente.
  - 409 `not_awaiting` si la ejecución no está esperando aprobación.
  - 404 `not_found` si la ejecución no existe.
  - ⚠️ **La identidad del actor la fija el SERVIDOR** (`humanActor`), NO el body.
    No envíes ningún `actorId`: se ignora.

### Knowledge Base
- ✅ `GET /knowledge?query=...&category=...&status=...` → `200 { documents: KnowledgeDoc[] }`
- ✅ `GET /knowledge/:id` → `200 { document: KnowledgeDoc }` (404 si no existe)

### SSE (tiempo real) — ver §5
- ✅ `GET /executions/:executionId/events`

⚠️ **No existen otros endpoints.** En particular NO hay: endpoint para aplicar
cambios directamente, para aprobar la HU con hash (la aprobación de la HU no pasa
por este endpoint; ver §6), ni para crear ejecuciones directamente (una ejecución
nace al enviar un mensaje de desarrollo).

---

## 4. Contratos y tipos de datos (verificados)

Reproduce estos tipos en el frontend (cópialos; no importes del Core).

### HandleResult — `src/core/saiki-core.ts`
```ts
type HandleCategory = "conversation" | "assistance" | "development" | "clarification";

interface HandleResult {
  sessionId: string;
  category: HandleCategory;
  confidence: number;
  reason: string;
  reply?: string;              // category=conversation
  clarifyingQuestion?: string; // category=clarification
  task?: DelegatedTask;        // category=assistance
  developmentThreadId?: string;// category=development  ← ESTE es el executionId
}
```
⚠️ El `executionId` que usarás en `/executions/...` es
`result.developmentThreadId` (solo presente cuando `category === "development"`).

### ExecutionView — `src/core/execution-view.ts`
```ts
type Availability = "available" | "unavailable" | "not_applicable";
type StageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "not_applicable";
type StageId =
  | "hu_analysis" | "technical_analysis" | "feasibility" | "development"
  | "functional_review" | "quality_review" | "final_approval" | "apply" | "verify";

interface ExecutionStage { id: StageId; label: string; status: StageStatus; detail?: string; }
interface PendingApprovalView { required: boolean; kind?: string; proposalHash?: string; }
interface FinalResultView { available: Availability; outcome?: string; detail?: string; }

interface ExecutionView {
  executionId: string;
  sessionId: Availability | string;   // id de sesión o "unavailable"
  request: Availability | string;
  category: "development";
  status: string;                      // texto legible
  phase: string;                       // fase cruda (estable), p. ej. "applied"
  currentStage: StageId | "none";
  stages: ExecutionStage[];            // SIEMPRE las 9 etapas
  runtime: Availability | string;      // ⚠️ hoy "unavailable" (ver §4 nota)
  errors: string[];
  retries: number;                     // ciclos de corrección
  pendingApproval: PendingApprovalView;
  finalResult: FinalResultView;
  events?: unknown[];                  // reservado; hoy no se rellena
}
```
⚠️ **Nota sobre "agente y runtime" por etapa**: el enunciado de UX pide mostrarlos
en el detalle de etapa, pero el backend HOY no los persiste por etapa:
`ExecutionView.runtime` es `"unavailable"`. Muéstralo como "no disponible", NO lo
inventes. (Para tareas de asistencia sí hay `DelegatedTask.runtime`.)

### ProposalView — `src/core/jev-contracts.ts`
```ts
interface ProposalView {
  threadId: string;
  proposalHash: string;    // ← úsalo tal cual al aprobar
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  risks: string[];
}
type HumanDecision = "approve" | "reject" | "request_changes";
```

### ApprovalResolution — `src/core/saiki-core.ts`
```ts
type ApprovalResolution =
  | { ok: true; decision: HumanDecision; actor: string; proposalHash: string; resolvedAt: string; phase: string; }
  | { ok: false; reason: "not_found" | "not_awaiting" | "hash_mismatch"; message: string; expectedHash?: string; };
```

### DelegatedTask — `src/moderator/delegation.ts`
```ts
type TaskStatus = "pending" | "blocked" | "running" | "succeeded" | "failed";
interface Evidence { description: string; source?: string; }
interface DelegatedTask {
  id: string; request: string; goal: string; context: Record<string, unknown>;
  agentRole: string; runtime: string;
  requiredCapabilities: string[]; grantedCapabilities: string[];
  memoryRefs: string[]; status: TaskStatus;
  result?: string; synthesis?: string;   // synthesis = respuesta natural (Fase 17)
  evidence: Evidence[]; errors: string[];
  createdAt: string; updatedAt: string;
}
```

### ModeratorSession — `src/moderator/moderator-types.ts`
```ts
interface ConversationTurn { role: "user" | "moderator"; text: string; at: string; classification?: unknown; }
interface ModeratorSession {
  sessionId: string; createdAt: string; updatedAt: string;
  turns: ConversationTurn[];
  delegatedTaskIds: string[];
  developmentThreadId?: string;   // enlaza la sesión con su ejecución de desarrollo
}
```

### KnowledgeDoc — `src/knowledge/kb-types.ts`
```ts
type KnowledgeCategory = "architecture" | "projects" | "research" | "decisions" | "lessons" | "conventions";
type KnowledgeStatus = "proposed" | "approved" | "superseded" | "archived";
interface KnowledgeDoc {
  id: string; title: string; category: KnowledgeCategory; status: KnowledgeStatus;
  content: string; origin: string; createdAt: string; updatedAt: string; supersededBy?: string;
}
```

---

## 5. Eventos SSE verificados

Fuente: `src/api/http-server.ts` (`handleSse`) + `src/events/event-types.ts`.

Endpoint: ✅ `GET /executions/:executionId/events`
- `Content-Type: text/event-stream; charset=utf-8`.
- Reconexión: envía el header estándar `Last-Event-ID` o `?lastEventId=<n>`; el
  servidor reenvía solo los eventos con `seq` mayor.
- Heartbeat: líneas de comentario `: ping <ts>` periódicas.
- 404 si la ejecución no existe; 501 si el servidor no tiene eventos configurados
  (con `npm run serve` SÍ están configurados).
- Un evento de control `event: control` con `data: { kind: "gap", ... }` indica
  que pediste eventos anteriores a los retenidos.

Formato de cada evento (líneas SSE):
```
id: 2
event: stage.completed
data: {"eventId":"...","type":"stage.completed","executionId":"dev-...","sessionId":"s1","timestamp":"...","seq":2,"data":{"stageId":"hu_analysis","label":"Análisis de HU"}}
```

### Tipos de evento y su `data`
```ts
type SaikiEventType =
  | "execution.started" | "execution.completed" | "execution.failed"
  | "stage.started" | "stage.completed" | "stage.failed"
  | "approval.required" | "approval.resolved"
  | "assistant.message" | "knowledge.proposed";

interface SaikiEvent {
  eventId: string; type: SaikiEventType;
  executionId?: string; sessionId?: string;
  timestamp: string; seq?: number; data: object;
}
// data por tipo:
// execution.*   → { phase: string; status: string }
// stage.*       → { stageId: StageId; label: string; detail?: string }
// approval.required → { kind: string; proposalHash?: string }
// approval.resolved → { decision: HumanDecision; actor: string; proposalHash: string; phase: string }
// assistant.message → { taskId: string; status: string; summary: string }
// knowledge.proposed → { docId: string; title: string; category: string }
```

⚠️ **Verdades importantes sobre los eventos (no las contradigas en la UI):**
- Los eventos de etapa son por DIFF del estado observado, no por cada nodo
  interno. En la **primera pausa** (aprobación de la HU) verás `stage.completed`
  (hu_analysis) + `approval.required`, pero NO `stage.started` — ninguna etapa
  está "en curso" con el grafo pausado. Es correcto, no un bug.
- `assistant.message` y `knowledge.proposed` NO tienen `executionId` (son de
  sesión/globales). El endpoint SSE por ejecución NO los entrega. Si quieres
  mostrarlos, obtenlos vía REST (sesión/KB), no por este SSE.
- Con EventSource del navegador, `Last-Event-ID` se reenvía automáticamente al
  reconectar; usa `es.addEventListener("<type>", ...)` por tipo.

---

## 6. Flujos de usuario (cómo encadenar llamadas)

### A. Iniciar y seguir un desarrollo
1. `POST /sessions` → `sessionId`.
2. `POST /sessions/:id/messages` con `{ message: "implementa ..." }`.
   - Si `result.category === "development"` → guarda `result.developmentThreadId`
     como `executionId`.
   - Si es `conversation` → muestra `result.reply`.
   - Si es `clarification` → muestra `result.clarifyingQuestion` y espera otro mensaje.
   - Si es `assistance` → muestra `result.task` (incl. `task.synthesis`).
3. Abre SSE: `GET /executions/:executionId/events` → pinta el pipeline en vivo.
4. `GET /executions/:executionId` → estado completo al cargar/recargar (recupera
   el pipeline sin depender del SSE).

### B. Resolver una aprobación de propuesta
1. Cuando llegue `approval.required` (o `pendingApproval.required === true`):
   `GET /executions/:executionId/approval` → `proposal` con `proposalHash`,
   archivos y riesgos.
2. Muestra el diálogo. El usuario elige approve/reject/request_changes (+feedback).
3. `POST /executions/:executionId/approval` con `{ decision, proposalHash }`
   (usa EXACTAMENTE el `proposalHash` recibido).
4. Maneja 409 `hash_mismatch` (la propuesta cambió: vuelve a consultar `/approval`
   y reintenta) y 409 `not_awaiting` (ya no hay nada que aprobar).

⚠️ **La aprobación de la HU** (etapa temprana, `kind: "hu_review"`) y la de
viabilidad parcial (`kind: "feasibility_partial"`) **NO** se resuelven por el
endpoint de aprobación (que exige `proposalHash`). HOY el backend NO expone una
ruta HTTP para resolverlas. **Trátalo como una limitación**: la UI puede mostrar
que se requiere esa decisión (`pendingApproval.kind`), pero no podrá resolverla
vía API todavía. No la simules. (Repórtalo como brecha; ver §13.)

### C. Resultado final
`GET /executions/:executionId/result` → `status` + `finalResult`
(`available`, `outcome` = fase terminal como `applied`, `rolled_back`, etc.).
Para el detalle (archivos, revisiones) combina con `GET /executions/:executionId`
(stages con `detail`).

---

## 7. Requisitos funcionales (dashboard de supervisión)

- **Dashboard principal**: lista de sesiones (`GET /sessions`); por sesión,
  mostrar `developmentThreadId` si existe, última actividad (`updatedAt`), y el
  primer turno de usuario como "solicitud original". Acceso al detalle.
- **Vista de ejecución**: pipeline con las 9 etapas (`ExecutionView.stages`),
  cada una con su `status` (pendiente/ejecutando/completada/error/omitida) y
  `detail`. Resaltar `currentStage` y `pendingApproval`. Tiempo real por SSE +
  recuperación por `GET /executions/:id` al recargar.
- **Detalle de etapa**: `label`, `status`, `detail`. Entrada/resultado: usar
  `detail` y, cuando aplique, el contexto de la ejecución. ⚠️ `agente/runtime`
  por etapa = "no disponible" (ver §4). Duración: ⚠️ el backend NO da timestamps
  por etapa hoy; muéstralo como "no disponible" o derívalo SOLO de los
  `timestamp` de los eventos SSE si los capturas (aproximado; etiquétalo como tal).
- **Aprobaciones**: diálogo con `proposal` (resumen, archivos, riesgos, hash),
  botones approve/reject/request_changes, campo de observaciones, y feedback del
  resultado (`ApprovalResolution`).
- **Resultado final**: solicitud, etapas, archivos (de `proposal`), estado de
  revisiones (etapas `functional_review`/`quality_review`), aprobaciones y
  `finalResult`.

Muestra ÚNICAMENTE lo que el backend entrega. Donde no haya dato: "no disponible".

---

## 8. Requisitos de diseño

- Dashboard limpio, profesional, orientado a supervisión técnica. Pipeline como
  elemento central.
- Etapas visualmente diferenciadas por estado (color + icono): pending (gris),
  running (azul/pulso), done (verde), failed (rojo), skipped (atenuado),
  not_applicable (oculto o muy tenue), + "requiere aprobación" (ámbar) derivado
  de `pendingApproval`.
- Panel lateral o modal para el detalle de etapa.
- Diálogo claro y bloqueante para aprobaciones (decisión deliberada).
- Indicadores de actividad (conexión SSE viva, heartbeat) y de error.
- Responsive. Evitar sobrecarga visual.

---

## 9. Restricciones de seguridad (OBLIGATORIAS)

- El frontend consume EXCLUSIVAMENTE la API REST + SSE. ❌ No importar módulos del
  Core, ❌ no tocar SQLite, ❌ no ejecutar agentes, ❌ no orquestar, ❌ no aplicar
  cambios, ❌ no simular aprobaciones ni inventar estados/eventos.
- La identidad del aprobador la pone el servidor: no envíes `actorId`.
- Aprobación atada al `proposalHash`: reenvíalo tal cual; maneja 409.
- ⚠️ **CORS / same-origin**: el servidor `http` nativo HOY no envía cabeceras CORS
  y escucha solo en `127.0.0.1`. Un frontend servido desde otro origen (p. ej.
  Vite en `:5173`) será bloqueado por el navegador. Opciones (NO modificar el
  backend): (a) usar un **proxy de desarrollo** (Vite `server.proxy`) que
  reenvíe `/sessions`, `/executions`, `/knowledge`, `/health` a `127.0.0.1:4123`
  (recomendado); (b) en producción, servir el build estático detrás del mismo
  origen mediante un proxy. Documenta esta decisión. Si te bloqueara también el
  SSE, el proxy de Vite lo cubre.

---

## 10. Arquitectura frontend recomendada (💡 PROPUESTA)

- 💡 **Vite + React + TypeScript** (SPA). Estándar, rápido, buen soporte de SSE
  vía `EventSource`. Alternativa válida: Svelte. Evita frameworks pesados.
- 💡 Ubicación: sub-proyecto independiente en `web/` (o `frontend/`), con su
  propio `package.json` y `node_modules`. NO mezclar con las dependencias del
  backend. El frontend NO importa de `src/`.
- 💡 Capa de acceso: un módulo `api/client.ts` con funciones tipadas (fetch) +
  `api/events.ts` que envuelve `EventSource`. Tipos copiados de §4 en `types.ts`
  (no importados del Core).
- 💡 Estado: TanStack Query (o SWR) para REST; un store ligero (Zustand o
  Context) para el estado del pipeline alimentado por SSE, reconciliado con el
  `GET /executions/:id` al cargar.
- 💡 Config: `VITE_API_BASE` (default `http://127.0.0.1:4123`) o proxy de Vite.
- 💡 Estilos: Tailwind o CSS modules; componentes propios (evitar librerías de UI
  pesadas). Un set mínimo: `PipelineView`, `StageNode`, `StageDetailPanel`,
  `ApprovalDialog`, `SessionList`, `ExecutionResult`, `ConnectionIndicator`.

---

## 11. Plan incremental de implementación (verificable por pasos)

1. **Esqueleto**: Vite + React + TS en `web/`, proxy a `127.0.0.1:4123`, página
   que llama `GET /health` y muestra "conectado".
2. **Tipos + cliente REST**: `types.ts` (de §4) y `api/client.ts`. Listar
   sesiones (`GET /sessions`) en el dashboard.
3. **Vista de ejecución (REST)**: `GET /executions/:id` → pipeline de 9 etapas
   estático (sin tiempo real aún). Recuperación al recargar.
4. **Detalle de etapa**: panel lateral/modal con lo disponible (label, status,
   detail; resto "no disponible").
5. **SSE**: `api/events.ts` con `EventSource`; actualizar el pipeline en vivo;
   indicador de conexión; reconexión con `Last-Event-ID` (automática).
6. **Aprobaciones**: `GET /approval` + diálogo + `POST /approval`; manejo de 409
   (hash_mismatch/not_awaiting) y feedback del resultado.
7. **Resultado final**: `GET /result` + composición con stages/proposal.
8. **Pulido**: responsive, estados de error, loading, vacíos; accesibilidad básica.

Cada paso debe compilar y funcionar contra `npm run serve`.

---

## 12. Criterios de aceptación

- El dashboard lista sesiones reales desde `GET /sessions`.
- Una ejecución de desarrollo muestra su pipeline de 9 etapas con estados reales.
- El pipeline se actualiza en vivo por SSE y se recupera correctamente al recargar
  (vía `GET /executions/:id`).
- El detalle de etapa muestra solo datos reales; lo no disponible se indica como tal.
- Una aprobación de **propuesta** se puede resolver (approve/reject/request_changes),
  reenviando el `proposalHash`, y se maneja el 409.
- La UI nunca aplica cambios ni simula aprobaciones; toda acción pasa por la API.
- No hay imports del Core ni acceso a SQLite.
- Funciona contra el backend real sin modificarlo (solo proxy de dev para CORS).

---

## 13. Limitaciones conocidas a respetar (no las "arregles" inventando)

1. ⚠️ **Agente/runtime por etapa**: `ExecutionView.runtime === "unavailable"`.
   No hay dato por etapa. Muéstralo como no disponible.
2. ⚠️ **Duración por etapa**: el backend no persiste timestamps por etapa. Solo
   puedes aproximar con los `timestamp` de eventos SSE (etiqueta como aproximado)
   o mostrar "no disponible".
3. ⚠️ **Aprobación de HU y viabilidad parcial**: no hay endpoint HTTP para
   resolverlas (solo la de propuesta tiene endpoint). La UI puede señalar que se
   requiere, pero no resolverla por ahora.
4. ⚠️ **`assistant.message` / `knowledge.proposed`** no llegan por el SSE de
   ejecución (no tienen `executionId`). Obtén esa info por REST.
5. ⚠️ **Sin CORS**: requiere proxy de desarrollo (ver §9).
6. ⚠️ **Identidad única local**: no hay auth multiusuario; el aprobador es el
   `humanActor` del servidor.

Estas brechas son candidatas a fases backend futuras; NO son tarea del frontend.

---

## 14. Comandos para ejecutar y probar

Backend (desde la raíz del repo, con Node 22):
```bash
nvm use 22
npm run serve     # API en http://127.0.0.1:4123 (aplica en copia temporal por defecto)
# opcional: SAIKI_API_PORT=5000 npm run serve
```

Smoke manual de la API:
```bash
curl -s http://127.0.0.1:4123/health
curl -s -XPOST http://127.0.0.1:4123/sessions -H 'content-type: application/json' -d '{"sessionId":"s1"}'
curl -s -XPOST http://127.0.0.1:4123/sessions/s1/messages -H 'content-type: application/json' -d '{"message":"implementa un util de suma"}'
# usa el developmentThreadId devuelto:
curl -s http://127.0.0.1:4123/executions/<threadId>
curl -N http://127.0.0.1:4123/executions/<threadId>/events
```

Frontend (sub-proyecto nuevo, lo creas tú):
```bash
# dentro de web/
npm install
npm run dev       # Vite; configura proxy a 127.0.0.1:4123
```

Backend — verificación (no la toques, pero puedes correrla):
```bash
npm run typecheck && npm test   # 237 tests, 27 archivos (estado actual)
```

---

## 15. Ejemplos reales de request/response

```
POST /sessions            {}                         → 201 {"sessionId":"sess-ab12cd34","existed":false}
POST /sessions/s1/messages {"message":"¿qué es X?"}   → 200 {"result":{"sessionId":"s1","category":"conversation","confidence":0.5,"reason":"...","reply":"..."}}
POST /sessions/s1/messages {"message":"implementa X"} → 200 {"result":{"sessionId":"s1","category":"development","confidence":0.9,"reason":"...","developmentThreadId":"dev-..."}}
GET  /executions/dev-...                              → 200 {"execution":{"executionId":"dev-...","category":"development","phase":"reviews_passed","currentStage":"none","stages":[{"id":"hu_analysis","label":"Análisis de HU","status":"done"}, ...],"pendingApproval":{"required":true,"kind":"final_approval","proposalHash":"<hash>"},"finalResult":{"available":"not_applicable"},...}}
GET  /executions/dev-.../approval                     → 200 {"pendingApproval":{"required":true,"kind":"final_approval","proposalHash":"<hash>"},"proposal":{"threadId":"dev-...","proposalHash":"<hash>","summary":"...","filesToCreate":["src/gen.ts"],"filesToModify":[],"filesToDelete":[],"risks":[]}}
POST /executions/dev-.../approval {"decision":"approve","proposalHash":"<hash>"} → 200 {"resolution":{"ok":true,"decision":"approve","actor":"local-human","proposalHash":"<hash>","resolvedAt":"...","phase":"applied"}}
POST /executions/dev-.../approval {"decision":"approve","proposalHash":"viejo"}  → 409 {"error":"hash_mismatch","message":"...","expectedHash":"<hash>"}
```
(Los valores exactos de `phase`/`status` dependen del avance real de la ejecución.)

---

## 16. Resumen de decisiones que Claude DEBE respetar

1. La API REST + SSE es la ÚNICA fuente de verdad. Cero imports del Core, cero
   SQLite, cero lógica de negocio en el frontend.
2. `executionId` = `HandleResult.developmentThreadId`.
3. Aprobar siempre con el `proposalHash` recibido; manejar 409. No enviar actorId.
4. Mostrar solo datos reales; "no disponible" donde el backend no da dato (runtime
   por etapa, duración por etapa).
5. SSE por ejecución NO trae `assistant.message`/`knowledge.proposed`; usar REST.
6. No resolver aprobaciones de HU/viabilidad por API (no existe endpoint).
7. Resolver CORS con proxy de dev; NO modificar el backend.
8. Frontend como sub-proyecto independiente (`web/`), Vite+React+TS recomendado.
9. Implementación incremental (§11), cada paso funcionando contra `npm run serve`.
10. No inventar endpoints, eventos, estados ni etapas.
