# Fase 19 — API REST local de Saiki-IA

> Capa HTTP DELGADA sobre `SaikiCore`, con el módulo `http` nativo (sin Express/
> Fastify). Escucha SOLO en `127.0.0.1`. No construye frontend, SSE ni eventos
> (eso es Fase 20/21). Reutiliza `JevCorePort`; no duplica lógica ni persistencia.

## 1. Ejecución local

```bash
nvm use 22
npm run serve            # http://127.0.0.1:4123
SAIKI_API_PORT=5000 npm run serve
```

Variables de entorno:
- `SAIKI_API_PORT` — puerto (default **4123**).
- `SAIKI_HUMAN_ACTOR` — identidad humana local (default `local-human`).
- (Project Registry) `SAIKI_APPLY_TO_REAL_REPO` ya no tiene efecto: el modo de
  aplicación se elige **por proyecto** (`sandbox` por defecto; `real` con
  confirmación explícita). Ver §5.3.

El estado persiste en `.saiki/` (gitignored): `checkpoints.sqlite` (flujos),
`core.sqlite` (sesiones/tareas, registro de proyectos), `knowledge.sqlite` (KB).

Al arrancar, el backend intenta registrar su propio directorio como primer
proyecto (D9), en modo sandbox y con actor `saiki-bootstrap`. Si no es un
repositorio git no lo registra (D1) y lo explica en el log.

## 2. Modelo de identidad y seguridad (local)

- El servidor escucha SOLO en `127.0.0.1`: no accesible desde la red ni Internet.
- La **identidad humana la fija el SERVIDOR** (`humanActor`), NUNCA el cuerpo de
  la petición. El frontend no envía `actorId`; no puede suplantar a otro actor.
- Las aprobaciones NO tienen ruta directa al Safe Applier: reanudan el grafo, que
  gobierna la aplicación. La API no puede escribir el repo por sí misma.
- Las aprobaciones de propuesta están atadas al **hash exacto**: un hash
  incorrecto/desactualizado se rechaza (409).
- Las respuestas de error están saneadas (truncadas): no filtran stderr crudo ni
  secretos de runtimes.

**Limitaciones (a evolucionar):** identidad única local, sin autenticación
multiusuario. Una fase futura añadiría auth real. Hoy el modelo asume un único
operador humano en la máquina local.

## 3. Endpoints

Todas las respuestas son JSON. Errores: `{ "error": "<code>", "message": "..." }`.

### Salud
- `GET /health` → `{ ok: true }`

### Sesiones
- `POST /sessions` — crea/registra una sesión. Body: `{ "sessionId"?: string,
  "projectId"?: string }`. → `201 { sessionId, existed, projectId? }`.
  (Project Registry) Con `projectId`, la sesión se **persiste** ligada a ese
  proyecto (activo y sano) y ese proyecto no cambia nunca. Sin él, como antes:
  sesión general que se crea con el primer mensaje. Errores: `404
  project_not_found`, `400 project_inactive`, `409 project_unhealthy`, `409
  session_project_mismatch` (la sesión ya existe con otro proyecto o es general).
- `GET /sessions` → `{ sessions: [...] }`; `?projectId=` filtra. Cada sesión
  incluye `projectId` si tiene proyecto.
- `GET /sessions/:id` → `{ session, tasks }` (404 si no existe)
- `POST /sessions/:id/messages` — Body: `{ "message": string }`.
  → `200 { result }` donde `result.category` ∈ `conversation | assistance |
  development | clarification`.
  (Project Registry) Una solicitud de desarrollo en una sesión sin proyecto, o
  con el proyecto desactivado o su repositorio no disponible, NO crea ejecución:
  responde `category: "clarification"` con `blockedReason: "project_required" |
  "project_unavailable"` y el motivo en `clarifyingQuestion` (D6: sin error HTTP).

### Proyectos (Project Registry)
Solo el humano administra el registro; el actor lo fija el servidor. Ningún
agente tiene acceso. `Project = { id, name, rootPath, status: "active" |
"inactive", applyMode: "sandbox" | "real", createdAt, updatedAt, deactivatedAt,
health, healthDetail? }`. `health` se calcula al leer: `ok | missing | moved |
not_a_repository | not_accessible`.
- `POST /projects` — Body: `{ "name", "path", "applyMode"?: "sandbox"|"real",
  "confirmRealApply"?: true }` → `201 { project }`. La ruta debe ser absoluta y
  la raíz de un repositorio git; se guarda su `realpath`. Errores `400
  invalid_name | invalid_path | not_accessible | not_a_repository |
  sensitive_path | invalid_apply_mode | confirmation_required`, `409
  already_registered` (con `projectId`) `| nested_project | name_taken`.
- `GET /projects?status=active|inactive` → `{ projects }`.
- `GET /projects/:id` → `{ project }` (404).
- `GET /projects/:id/history` → `{ projectId, history: [{ id, action, actor, at,
  details }] }`; `action` ∈ `registered | renamed | apply_mode_changed |
  deactivated | reactivated`. Solo inserción.
- `PATCH /projects/:id` — `{ "name"?, "applyMode"?, "confirmRealApply"? }`. La
  ruta no se edita (`400 path_immutable`): mover un repo = registrar otro proyecto.
- `POST /projects/:id/deactivate` → `{ project }`; `409 has_active_executions`
  si una ejecución del proyecto está trabajando ahora (pausadas sí: D5).
- `POST /projects/:id/activate` → `{ project }`; `409 project_unhealthy` si el
  repositorio ya no es el registrado, `409 name_taken | nested_project`.

### Ejecuciones (desarrollo)
- `GET /executions/:threadId` → `{ execution: ExecutionView }` (404 si no existe)
- `GET /executions/:threadId/stages` → `{ executionId, currentStage, stages }`
- `GET /executions/:threadId/result` → `{ executionId, status, finalResult }`

### Aprobaciones
- `GET /executions/:threadId/approval` → `{ pendingApproval, proposal, gate }`
  (`proposal` incluye `proposalHash`, archivos y riesgos cuando aplica).
  (Fase 21) `pendingApproval.decisionHash` es el hash de la versión a decidir en
  cualquier tipo de aprobación (en `final_approval` = `proposalHash`). `gate` trae
  lo necesario para decidir `hu_review` / `feasibility_partial` (null en otro caso).
- `POST /executions/:threadId/approval` — aprobación FINAL de la propuesta. Body:
  `{ "decision": "approve"|"reject"|"request_changes", "proposalHash": string,
  "feedback"?: string }`.
  La identidad del actor la pone el servidor (no el body).
  → `200 { resolution }` | `409 hash_mismatch | not_awaiting | project_unbound`
  | `404 not_found`. (`project_unbound`: ejecución anterior al registro de
  proyectos; solo admite `reject`. Ver §5.3.)
- (Fase 21) `POST /executions/:threadId/approval/:kind` — revisión de HU y
  viabilidad parcial (`kind` = `hu_review` | `feasibility_partial`). Ver §5.1.

### Knowledge Base
- `GET /knowledge?query=...&category=...&status=...` → `{ documents: [...] }`
- `GET /knowledge/:id` → `{ document }` (404 si no existe)
  (La promoción a oficial sigue exigiendo actor humano; no se expone un endpoint
  que relaje esa regla.)

## 4. ExecutionView (contrato normalizado)

Proyección ESTABLE del estado del grafo, sin exponer `HuState`. Campos:

- `executionId`, `sessionId`, `request`, `category: "development"`.
- `status` (legible), `phase` (string estable), `currentStage`.
- `stages[]`: 9 etapas (`hu_analysis`, `technical_analysis`, `feasibility`,
  `development`, `functional_review`, `quality_review`, `final_approval`,
  `apply`, `verify`), cada una con `status` (`pending|running|done|failed|
  skipped|not_applicable`) y `detail` opcional.
- `runtime`: disponibilidad (hoy `unavailable` por etapa — brecha documentada).
- `errors[]`, `retries` (ciclos de corrección).
- `pendingApproval`: `{ required, kind?, proposalHash?, decisionHash? }`.
  (Estabilización) `required` solo es true si el grafo está PAUSADO de verdad
  en esa puerta (interrupt), nunca a mitad de una ejecución.
- `finalResult`: `{ available, outcome?, detail? }`.
- `events?`: reservado para Fase 20 (no rompe el contrato).
- (Estabilización, aditivos) `lifecycle`: `running | awaiting_decision |
  interrupted | completed | failed | stopped` (única clasificación fiable; ver
  `src/core/execution-lifecycle.ts`). `activity: { active, since?, trigger? }`.
  `activeStage`: etapa que se ejecuta de verdad (`none` si no hay actividad).
  `awaitingDecision: { kind, stageId?, afterStageId? } | null`. `status` se
  redacta a partir de `lifecycle`. `currentStage` se conserva por compatibilidad
  (obsoleto: marca `final_approval` en espera como `running`).
- No existe `cancelled`: el sistema no soporta cancelar ejecuciones.
- (Project Registry, aditivos) `project: { id, name, rootPath, applyMode,
  boundAt, current: { name, status, applyMode, health, healthDetail? } | null } |
  null`: la copia INMUTABLE del proyecto con la que nació la ejecución y, en
  `current`, el proyecto tal como está hoy en el registro. `null` = ejecución
  anterior al registro. `applyTarget: string | null`: directorio donde se aplicó
  (repo real o sandbox de la ejecución).

Es HONESTA: distingue `available` / `unavailable` / `not_applicable` y no inventa
etapas, resultados ni estados.

## 5. Lock de aprobaciones (concurrencia)

`SaikiCore.resolveApproval` serializa las resoluciones POR `threadId`
(`KeyedMutex`), no global: dos ejecuciones distintas avanzan en paralelo; dos
resoluciones simultáneas de la MISMA ejecución se encolan. La segunda ve el
estado ya avanzado (ya no hay aprobación pendiente con ese hash) → 409. Así una
aprobación no se procesa dos veces.

Antes de reanudar, `resolveApproval` verifica: que la ejecución exista, que esté
esperando aprobación, y que el hash coincida con la propuesta pendiente. Registra
identidad + decisión + fecha + hash + observaciones en la sesión (auditoría).

### 5.0. Una ejecución por solicitud (estabilización)

Cada mensaje clasificado como desarrollo crea una ejecución NUEVA (`dev-<uuid>`).
Una ejecución pausada no se reinicia y una terminada (completada, fallida o
detenida) es definitiva: ningún mensaje posterior la reactiva. La sesión lista
todas sus ejecuciones en `developmentThreadIds` (orden de creación) y
`developmentThreadId` apunta a la más reciente (las sesiones anteriores a este
cambio solo tienen `developmentThreadId`).

Una decisión que llega mientras la ejecución está trabajando (`lifecycle:
running`) recibe `409 not_awaiting` de inmediato (antes esperaba al lock durante
toda la ejecución). La aprobación final exige además que el grafo esté pausado en
`final_approval`.

### 5.1. Revisión de HU y viabilidad parcial (Fase 21)

Antes de la Fase 21, las ejecuciones iniciadas por la API quedaban pausadas en
`hu_review` sin forma de resolverse por HTTP. `SaikiCore.resolveGate` lo resuelve
con las MISMAS garantías y el MISMO lock por ejecución que `resolveApproval`.

`POST /executions/:threadId/approval/:kind`

```json
{ "decision": "approve" | "reject" | "request_changes", "decisionHash": "<pendingApproval.decisionHash>", "feedback": "opcional" }
```

| `kind` | `approve` | `request_changes` | `reject` |
|---|---|---|---|
| `hu_review` | aprueba la HU → análisis técnico | regenera la HU con `feedback` (nueva versión; con el cupo agotado → `revision_limit`) | termina (`rejected`) |
| `feasibility_partial` | procede con lo implementable → desarrollo | **400 `unsupported_decision`** (la puerta no tiene ruta de revisión) | termina (`blocked`) |

Respuestas:
- `200 { resolution: { ok: true, kind, decision, actor, decisionHash, resolvedAt, phase } }`
  (`phase` = fase tras reanudar; la petición espera a que el grafo vuelva a pausarse o termine).
- `400 bad_request` — `decision` inválida, falta `decisionHash`, o `kind` no soportado
  (la aprobación final se resuelve en `POST /executions/:id/approval`).
- `400 unsupported_decision` — la puerta no admite esa decisión.
- `404 not_found` — la ejecución no existe.
- `409 not_awaiting` — la ejecución no está PAUSADA en esa puerta: ya se resolvió,
  terminó o espera otra (`pendingKind` indica cuál).
- `409 hash_mismatch` — la versión cambió (`expectedHash` = la vigente).

Protección de versiones: el hash es SHA-256 determinista calculado desde el
checkpoint (sin estado nuevo en el grafo, sobrevive a reinicios):
- `hu_review`: número de versión de la HU + su contenido. Tras `request_changes`
  el hash cambia aunque el contenido regenerado sea idéntico.
- `feasibility_partial`: versión de la HU + análisis técnico + clasificación,
  motivos y rutas no verificables.

Garantías: solo se acepta si el grafo está realmente pausado en esa puerta
(interrupt pendiente, no "siguiente nodo" a mitad de una ejecución); identidad
del servidor (`actorId` del body se ignora); auditoría en la sesión
(`Aprobación "approve" (hu_review) por <actor> sobre hash <hash>`) y evento
`approval.resolved` con `kind`.

`gate` en `GET /executions/:id/approval`:
- `hu_review`: `{ kind, threadId, decisionHash, version, revisionsUsed, maxRevisions, allowedDecisions, hu }`.
- `feasibility_partial`: `{ kind, threadId, decisionHash, feasibility, reasons, unresolvedPaths, allowedDecisions, technicalAnalysis }`.

`SaikiCore.submitApproval` traduce ahora la decisión según la puerta pendiente
(HU: `request_changes` → `revise`; viabilidad: `approve` → `proceed`) y rechaza
una decisión no admitida. Antes, esas combinaciones se interpretaban en silencio
como rechazo.

### 5.2. Historial inmutable de propuestas y decisiones (estabilización)

Solo lectura. Persistido en `core.sqlite` (tablas `proposal_versions` y
`human_decisions`, solo inserción; triggers de SQLite impiden `UPDATE`/`DELETE`).
Cada versión de propuesta se captura del historial de checkpoints tras cada tramo
del grafo (también las rehechas en ciclos de corrección); las ejecuciones
anteriores a este cambio se reconstruyen de checkpoints y de los eventos
`approval.resolved` (estas decisiones llevan `source: "events"` y sin
observaciones).

- `GET /executions/:id/proposals` → `{ executionId, proposals: ProposalHistoryItem[] }`
  (orden de versión). Cada item: `{ id ("<executionId>:v<n>"), version,
  proposalHash, summary, filesToCreate, filesToModify, filesToDelete, risks,
  createdAt, status, applied, reviews: [{ kind, cycle, decision }], decision }`.
  `status`: `pending | approved | rejected | changes_requested |
  rejected_by_review | current | superseded`.
- `GET /executions/:id/proposals/:hash` → `{ proposal }` (404 si no existe).
- `GET /executions/:id/decisions` → `{ executionId, decisions: DecisionView[] }`:
  `{ id, kind, subjectHash, decision, actor, feedback, resolvedAt, phaseAfter, source }`
  para HU, viabilidad parcial y aprobación final.
- 404 si la ejecución no existe.

### 5.3. Proyectos y ejecuciones (Project Registry)

- **Vinculación**: al crear una ejecución, el Core la ata a una copia del proyecto
  de SU sesión (id, ruta real, modo, huella del repo) en dos sitios: el estado del
  grafo (campo `project`, reducer que conserva el primer valor) y la tabla
  `execution_projects` (solo inserción). Renombrar, cambiar el modo o desactivar el
  proyecto después no cambia la copia.
- **Agentes**: todos los agentes del flujo se lanzan con `cwd` = repositorio de la
  ejecución. La asistencia (OpenCode) usa el repositorio del proyecto de la sesión;
  en una sesión general, un directorio vacío temporal (nunca el del backend).
- **Guardia de aplicación**, evaluada en `applyTask` justo antes de escribir: la
  copia del estado y la de la tabla coinciden; el proyecto existe, está activo y
  tiene la misma ruta; la ruta real, `.git` y la huella (`dev`, `ino`, directorio
  git) no cambiaron. Si algo falla: `phase: "apply_blocked"` con el motivo en
  `errors`, sin escribir nada y sin buscar el repositorio en otra ruta.
- **Destino**: repositorio real solo si el proyecto estaba en `real` al vincular Y
  lo está ahora; si no, un sandbox propio de la ejecución (copia completa sin
  `.git`, `node_modules` ni artefactos de build), nunca compartido.
- Ninguna propuesta puede tocar `.git/` ni `.saiki/`.
- **Ejecuciones anteriores al registro** (`project: null`): no consta su
  repositorio, así que no se reanudan: aprobar o pedir cambios → `409
  project_unbound`; rechazar sí se permite. Nunca se aplica sobre el directorio
  actual del backend.
- **Riesgo residual documentado**: `fs_read` de Kiro no está confinado a un
  directorio; un agente podría LEER fuera del proyecto si lo intenta (no escribir:
  los agentes no escriben). Confinarlo exigiría un sandbox del sistema operativo.

## 6. Ejemplos con curl

```bash
# Salud
curl -s http://127.0.0.1:4123/health

# Registrar un proyecto (raíz de un repositorio git)
curl -s -XPOST http://127.0.0.1:4123/projects \
  -H 'content-type: application/json' -d '{"name":"mi-app","path":"/Users/yo/dev/mi-app"}'

# Crear una sesión ligada al proyecto
curl -s -XPOST http://127.0.0.1:4123/sessions \
  -H 'content-type: application/json' -d '{"sessionId":"s1","projectId":"<prj-…>"}'

# Enviar un mensaje (consulta)
curl -s -XPOST http://127.0.0.1:4123/sessions/s1/messages \
  -H 'content-type: application/json' -d '{"message":"¿cómo funciona el router?"}'

# Solicitud de desarrollo (devuelve result.developmentThreadId)
curl -s -XPOST http://127.0.0.1:4123/sessions/s1/messages \
  -H 'content-type: application/json' -d '{"message":"implementa un util de suma"}'

# Consultar la ejecución normalizada
curl -s http://127.0.0.1:4123/executions/<threadId>

# Ver la aprobación pendiente (incluye proposalHash)
curl -s http://127.0.0.1:4123/executions/<threadId>/approval

# (Fase 21) Revisar la HU / decidir la viabilidad parcial (decisionHash del GET anterior)
curl -s -XPOST http://127.0.0.1:4123/executions/<threadId>/approval/hu_review \
  -H 'content-type: application/json' -d '{"decision":"approve","decisionHash":"<hash>"}'
curl -s -XPOST http://127.0.0.1:4123/executions/<threadId>/approval/feasibility_partial \
  -H 'content-type: application/json' -d '{"decision":"approve","decisionHash":"<hash>"}'

# Aprobar (el proposalHash debe coincidir con el pendiente)
curl -s -XPOST http://127.0.0.1:4123/executions/<threadId>/approval \
  -H 'content-type: application/json' \
  -d '{"decision":"approve","proposalHash":"<hash>"}'

# Buscar conocimiento aprobado
curl -s 'http://127.0.0.1:4123/knowledge?query=router&status=approved'
```

## 7. Pruebas

`src/api/http-server.test.ts` (13 tests, cubren los 15 escenarios de aceptación):
arrancan el servidor en un puerto efímero (`port: 0`) con un `SaikiCore` de
dobles deterministas y hacen `fetch` real a 127.0.0.1. Incluyen: escucha en
localhost, CRUD de sesiones, consulta/investigación/desarrollo, ExecutionView,
aprobación válida (reanuda el grafo + identidad registrada), hash incorrecto
(409), doble aprobación simultánea (200+409), ejecuciones independientes, errores
HTTP coherentes, reinicio sin pérdida (SQLite), y que ningún endpoint salta el
Safe Applier/aprobaciones.

Suite completa: 221 tests en 25 archivos (fases 1-18 verdes).

## 8. Eventos en tiempo real (SSE) — añadido en Fase 20

`GET /executions/:executionId/events` expone los eventos de la ejecución por
Server-Sent Events (reconexión con `Last-Event-ID`, heartbeat). Ver
`docs/EVENTS.md` para el contrato de eventos y ejemplos. La UI futura usará REST
para consultas/acciones y SSE para actualizaciones.

Fuera de alcance aún: frontend, WebSockets, autenticación multiusuario,
despliegue remoto (fase 21: Jev).

## 9. Archivos de esta fase

- `src/api/http-server.ts` — servidor REST (`http` nativo).
- `src/api/serve.ts` — arranque local (`npm run serve`).
- `src/core/execution-view.ts` — `ExecutionView` + proyector.
- `src/core/approval-lock.ts` — `KeyedMutex` (lock por ejecución).
- `src/core/saiki-core.ts` — `getExecution`, `resolveApproval`.
- `src/api/http-server.test.ts` — tests de aceptación.
- (Project Registry) `src/projects/*` (registro, validación en disco, vinculación,
  guardia de aplicación, registro automático D9) y sus pruebas;
  `src/api/projects.test.ts` (endpoints de proyectos y sesiones con proyecto).
- (Fase 21) `src/api/gates.test.ts` — revisión de HU y viabilidad parcial por HTTP;
  `hashHuReview` (`src/hu/hu-schema.ts`), `hashFeasibilityDecision`
  (`src/dev/feasibility.ts`), `resolveGate`/`getPendingGate` (`src/core/saiki-core.ts`).
