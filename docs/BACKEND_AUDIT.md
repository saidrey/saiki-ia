# Fase 18 — Auditoría del backend y diseño de API para una futura interfaz

> Nombre oficial: `saiki-ia`. Fase EXCLUSIVAMENTE de auditoría y diseño. No se
> construyó frontend, ni servidor HTTP, ni endpoints. Prioridad: conocer con
> exactitud qué tenemos antes de construir encima.

## 1. Diagnóstico de la arquitectura actual

Saiki-IA es hoy un **backend embebible por biblioteca**, no un servicio en red.
Su punto de integración es la clase `SaikiCore` (`src/core/saiki-core.ts`), que
se instancia en proceso e implementa `JevCorePort` (`src/core/jev-contracts.ts`).

Capas reales (verificadas en código):

| Capa | Componente | Archivo |
|------|-----------|---------|
| Punto de integración | `SaikiCore` (clase) | `src/core/saiki-core.ts` |
| Fachada/contrato | `JevCorePort` (interface) | `src/core/jev-contracts.ts` |
| Moderador | `BasicModerator` / `LlmModerator` | `src/moderator/` |
| Motor conversacional | `ConversationEngine` + Claude | `src/moderator/conversation-engine.ts`, `claude-conversation-engine.ts` |
| Grafo de desarrollo | `buildHuGraph` (LangGraph) | `src/hu/hu-graph.ts` |
| Estado del grafo | `HuState` (Annotation.Root) | `src/hu/hu-state.ts` |
| Aplicación segura | Safe Applier | `src/apply/` |
| Persistencia de flujos | checkpointer SQLite | `src/persistence/checkpointer.ts` |
| Persistencia de sesiones/tareas | `CoreStore` (SQLite) | `src/core/core-store.ts` |
| Knowledge Base | `KnowledgeStore` (SQLite) | `src/knowledge/kb-store.ts` |

**Dependencias de producción** (confirmado en `package.json`): solo
`@langchain/core`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite`.
No hay Express, Fastify, Koa, `ws` ni `socket.io`.

## 2. ¿Existe un servidor HTTP funcional?

**NO.** Evidencia objetiva:
- `grep` de `createServer|listen(|express|fastify|WebSocket|ServerResponse|EventSource`
  en `src/**/*.ts`: las ÚNICAS coincidencias son dos COMENTARIOS que precisamente
  prohíben el servidor HTTP (`src/hu/hu-graph.ts` línea 29, `src/core/jev-contracts.ts`
  línea 13). No hay ninguna implementación.
- `package.json` no declara ninguna dependencia de servidor web.
- Los puntos de entrada ejecutables son scripts CLI/demo (`src/index.ts`, demo del
  pipeline viejo; `src/manual/*.ts`, integraciones opt-in). Ninguno abre un puerto.

Conclusión: lo que existe son **contratos TypeScript y servicios internos en
proceso**, no una API HTTP. Es exactamente lo que el enunciado pide no confundir.

## 3. Mecanismo actual para recibir solicitudes

`SaikiCore.process(sessionId, message)` (y su alias `sendMessage`) es el único
punto de entrada funcional. Flujo real (`src/core/saiki-core.ts`):

1. Recupera o crea la `ModeratorSession` (`CoreStore`).
2. `decide()` normaliza la clasificación del moderador (síncrono o async).
3. Enruta: `conversation` (responde), `assistance` (delega + sintetiza),
   `development` (arranca el grafo), `clarification` (pregunta).
4. Persiste la sesión y, en asistencia, la tarea.

Las aprobaciones de desarrollo se transmiten con `submitApproval(threadId,
decision, feedback)`, que reanuda el grafo (`Command({resume})`).

## 4. Auditoría del estado de las ejecuciones

Qué se puede consultar HOY y de dónde sale:

| Dato solicitado | ¿Disponible? | Fuente |
|-----------------|--------------|--------|
| Identificador de ejecución | Sí | `developmentThreadId` (sesión) / `thread_id` del grafo |
| Solicitud original | Sí | `ModeratorSession.turns[]` (persistido en `CoreStore`) |
| Tipo de solicitud | Sí | `turn.classification.category` / `HandleResult.category` |
| Estado general | Sí | `HuState.phase` vía `getFlowStatus()` |
| Etapa actual | Parcial | `getState().next` (nodos pendientes del grafo) |
| Historial de etapas | Parcial | `reviewHistory[]` (revisiones) + `decisions[]`; no un log unificado de TODAS las etapas |
| Agente y runtime | Parcial | tareas de asistencia: `DelegatedTask.runtime`. Desarrollo: implícito en el router, no persistido por etapa |
| Entradas/resultados por etapa | Parcial | el estado del grafo guarda artefactos (`devProposal`, reviews, `verification`), no un registro entrada→salida por nodo |
| Errores y reintentos | Parcial | `HuState.error`, `reviewCycles`, `applyReport`; reintentos del desarrollo sí (ciclos), no un historial de errores general |
| Aprobaciones pendientes | Sí | `getFlowStatus().awaitingApproval` + `getState().next` |
| Aprobaciones resueltas | Sí | `HuState.decisions[]` + `auditRecord` |
| Resultado final | Sí | `HuState.phase` terminal + `verification` + `auditRecord` (desarrollo); `task.synthesis` (asistencia) |

**Persistido en SQLite**: estado del grafo (checkpointer), sesiones y tareas
(`CoreStore`), conocimiento (`KnowledgeStore`). **Solo en memoria/retorno**: el
`HandleResult` de `process()` no se persiste como tal (se reconstituye del estado);
no hay un "registro de ejecución" unificado y consultable por id con todas las
etapas normalizadas.

## 5. Auditoría de eventos

**NO existe un mecanismo de eventos de dominio.** Evidencia: `grep` de
`EventEmitter|emit(|publish|subscribe|dispatch` en `src/**` solo encuentra
`child.on(...)` (spawn de procesos) y `rl.on(...)` (readline de la CLI). No hay
ninguno de los eventos listados (`execution.started`, `stage.*`, `approval.*`,
`assistant.message`, `knowledge.proposed`).

El estado hoy se obtiene por **polling** (`getFlowStatus`, `getState`), no por
push. Una UI en tiempo real necesitaría, o bien polling, o introducir un bus de
eventos (ver propuesta).

## 6. Auditoría de aprobaciones (perspectiva de integración)

Cómo podría una interfaz operar hoy, usando `SaikiCore`:

- **Consultar pendientes**: `getFlowStatus(threadId).awaitingApproval` (true si el
  grafo está pausado en un `interrupt`). No hay un listado global de "todas las
  aprobaciones pendientes del sistema"; se consulta por `threadId`.
- **Detalles de la propuesta**: `getPendingProposal(threadId)` → hash, resumen,
  archivos a crear/modificar/eliminar, riesgos.
- **Aprobar / rechazar / comentar**: `submitApproval(threadId, "approve" |
  "reject" | "request_changes", feedback?)`.
- **Recuperar tras interrupción**: el estado del grafo persiste en SQLite; al
  reinstanciar `SaikiCore` con el mismo checkpointer y `threadId`, el flujo
  pausado sobrevive (probado en fases 13/15/16).

Garantías ya presentes (no se tocan): la aprobación está atada al **hash exacto**
de la propuesta (`devProposalHash`); si la propuesta cambia, el hash cambia y la
aprobación se invalida (Fase 12/13). La escritura solo ocurre vía el Safe Applier.

**Brecha de concurrencia**: hoy nada impide que DOS llamadas a
`submitApproval(threadId, ...)` se procesen sobre el mismo `threadId`. LangGraph
reanuda desde el checkpoint; una segunda resolución podría operar sobre un estado
ya avanzado. No hay un lock por ejecución. Debe resolverse en la capa de API
(ver seguridad).

## 7. Contratos y "endpoints" existentes

No hay endpoints HTTP. El "contrato de integración" es `JevCorePort`
(`src/core/jev-contracts.ts`), ya implementado por `SaikiCore`:

Consultas (solo lectura): `listSessions`, `getSession`, `listTasks`,
`getFlowStatus`, `getPendingProposal`, `searchKnowledge`, `getKnowledgeDoc`.
Acciones (el Core ejecuta): `sendMessage`, `submitApproval`,
`requestKnowledgeApproval`.

Esta interfaz es la base natural sobre la que montar una API: ya separa consulta
de acción y no expone internals.

## 8. Propuesta de arquitectura para exponer el Core

Capa DELGADA sobre `SaikiCore`, sin reescribir nada. Recomendación:

- **REST** para comandos y consultas, mapeando 1:1 (o casi) a `JevCorePort`.
  No todas las operaciones necesitan endpoint propio: varias consultas pueden
  agruparse bajo recursos (`/sessions/:id`, `/executions/:threadId`).
- **SSE** (Server-Sent Events) para actualizaciones en tiempo real. SSE es más
  simple que WebSocket y encaja con un flujo servidor→cliente (estados de
  ejecución, aprobaciones requeridas). Solo se justifica si antes se añade un
  **bus de eventos** mínimo en el Core (hoy inexistente); mientras tanto, la UI
  puede hacer polling de `getFlowStatus`.

Mapa propuesto (operaciones → recurso, justificado por los contratos actuales):

| Operación del enunciado | Endpoint propuesto | Método del Core que reutiliza |
|-------------------------|--------------------|-------------------------------|
| Crear sesión | `POST /sessions` | crea `ModeratorSession` (ya implícito en `process`) |
| Enviar mensaje | `POST /sessions/:id/messages` | `sendMessage` / `process` |
| Consultar ejecución | `GET /executions/:threadId` | `getFlowStatus` |
| Consultar etapas | `GET /executions/:threadId/stages` | derivar de `getState` + `reviewHistory` (requiere normalización) |
| Detalle de etapa | `GET /executions/:threadId/stages/:stage` | ídem (brecha: no hay registro por etapa) |
| Consultar eventos | `GET /executions/:threadId/events` (SSE) | requiere bus de eventos (brecha) |
| Aprobaciones pendientes | `GET /executions/:threadId/approval` | `getPendingProposal` + `getFlowStatus` |
| Resolver aprobación | `POST /executions/:threadId/approval` | `submitApproval` |
| Resultados finales | `GET /executions/:threadId/result` | `getFlowStatus` + estado terminal + `auditRecord` |
| Historial | `GET /sessions/:id` | `getSession` (turns) + `listTasks` |
| Buscar conocimiento | `GET /knowledge?query=` | `searchKnowledge` |

## 9. Requisitos de seguridad (a respetar en la futura API)

- No exponer SQLite directamente: la API habla con `SaikiCore`, nunca con la base.
- La API NO invoca el Safe Applier: solo `submitApproval` reanuda el grafo, que
  gobierna la aplicación. La UI no tiene ruta directa a escribir el repo.
- Validar antes de aprobar: identidad del actor, estado del flujo (que esté
  realmente esperando aprobación) y hash de la propuesta (debe coincidir con el
  que se mostró). El contrato de aprobación ya está atado al hash; la API debe
  reenviar y verificar ese hash.
- No confiar en el frontend para permisos: la autorización se decide en el
  servidor (p. ej. quién puede aprobar conocimiento = actor humano, ya exigido
  por la KB).
- Evitar doble resolución de la misma aprobación: introducir un **lock/mutex por
  `threadId`** (o verificación optimista contra el estado actual) en la capa de
  API, ya que hoy el Core no lo garantiza (ver §6).
- No exponer secretos de runtimes: los adaptadores ya no devuelven credenciales;
  la API no debe filtrar stderr crudo ni tokens.

## 10. Brechas para construir la interfaz gráfica

1. **No hay servidor HTTP** (ni dependencia). Hay que añadir una capa de red.
2. **No hay bus de eventos**: el seguimiento en tiempo real hoy es por polling.
3. **No hay un "registro de ejecución" normalizado** por etapas (entrada→salida,
   errores, reintentos) consultable por id; la información existe dispersa en el
   estado del grafo y habría que proyectarla a una vista estable.
4. **No hay listado global de aprobaciones pendientes** (solo por `threadId`).
5. **No hay control de concurrencia** por ejecución (doble aprobación posible).
6. **No hay autenticación/identidad** de actores (la KB distingue humano/agente
   por convención de nombre, no por identidad verificada).

Ninguna de estas brechas es un defecto de las fases previas: eran explícitamente
fuera de alcance. Son el trabajo natural de la capa de API.

## 11. Plan recomendado para la siguiente fase (implementación)

Incremental y KISS, en este orden:

1. **Capa HTTP mínima** (una sola dependencia ligera o el `http` nativo) que
   envuelva `SaikiCore` y exponga los recursos del §8 como REST. Sin tocar el
   Core salvo para añadir, si hace falta, métodos de proyección de lectura.
2. **Vista de ejecución normalizada**: un método en el Core que proyecte el
   estado del grafo a una `ExecutionView` estable (id, tipo, estado, etapas,
   aprobaciones, resultado), para no filtrar la forma interna de `HuState`.
3. **Lock por `threadId`** en la capa de API para la resolución de aprobaciones
   (y/o verificación optimista contra el estado actual).
4. **Bus de eventos mínimo** en el Core (un `EventEmitter` interno con los
   eventos del §3) + endpoint **SSE** que lo exponga. Solo entonces, tiempo real.
5. **Identidad/autz** básica para aprobaciones (quién aprueba), decidida en el
   servidor.
6. Recién después, construir el frontend (Jev) contra esa API estable.

Sugerencia de secuenciación: Fase 19 = capa HTTP REST + `ExecutionView` + lock de
aprobaciones (sin eventos). Fase 20 = bus de eventos + SSE. Fase 21 = Jev.

## 12. Resumen ejecutivo

- Backend sólido y probado (208 tests en 24 archivos), pero **embebido por
  biblioteca**: no hay HTTP, ni eventos, ni API.
- El contrato `JevCorePort` ya es la base ideal para una API delgada.
- Las garantías de seguridad (aprobación por hash, Safe Applier único escritor,
  conocimiento aprobado por humano) están intactas y deben preservarse en la API.
- Brechas claras y acotadas: red, eventos, vista de ejecución normalizada,
  concurrencia de aprobaciones, identidad.
