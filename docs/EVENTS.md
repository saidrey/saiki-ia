# Fase 20 — Bus de eventos y SSE

> Nombre oficial: `saiki-ia`. Añade eventos de dominio y los expone por SSE para
> que una futura UI observe en tiempo real. Reutiliza el Core y la API REST de la
> Fase 19. No modifica el flujo de negocio ni las garantías de seguridad.

## 1. Principio: eventos REALES, no artificiales

El grafo de LangGraph ejecuta sus nodos internamente; el Core no "ve" cada
transición en vivo, solo el estado tras cada `invoke`/reanudación. Por eso los
eventos se derivan de los **puntos reales** donde el Core observa cambios:

- `process()` (desarrollo): tras el `invoke`, se proyecta `ExecutionView` y se
  emiten los eventos correspondientes al estado observado.
- `submitApproval()` / `resolveApproval()`: tras reanudar, se emite el progreso.
- `process()` (asistencia) → `assistant.message`.
- `proposeKnowledge()` → `knowledge.proposed`.

Los eventos de etapa (`stage.*`) se calculan por **diff** del `ExecutionView`:
solo se emite una etapa cuyo estado CAMBIÓ. Consecuencia honesta: en la primera
pausa (aprobación de la HU) se emite `stage.completed` (hu_analysis) y
`approval.required`, pero NO `stage.started` — ninguna etapa queda "en curso"
con el grafo pausado. No se inventa una etapa running para rellenar.

**No se instrumentó el grafo** (no se modificó su lógica) ni el Safe Applier.

## 2. Contrato de eventos (`src/events/event-types.ts`)

Cada evento: `{ eventId, type, executionId?, sessionId?, timestamp, seq?, data }`.
`seq` lo asigna el store (incremental POR ejecución; es el `Last-Event-ID`).

Tipos y su `data`:

| type | data |
|------|------|
| `execution.started` / `completed` / `failed` / `stopped` | `{ phase, status, lifecycle? }` |
| `stage.started` / `completed` / `failed` | `{ stageId, label, detail? }` |
| `approval.required` | `{ kind, proposalHash?, decisionHash? }` |
| `approval.resolved` | `{ decision, actor, proposalHash, phase, kind? }` |

(Estabilización) El evento terminal sale del ciclo de vida: `completed` →
`execution.completed`, fallo técnico → `execution.failed`, parada humana o de
política (rechazo, límites, bloqueo) → `execution.stopped` (antes se emitía
`execution.failed` para un rechazo humano). Cada evento terminal se emite una
sola vez.

(Fase 21) `decisionHash` y `kind` son aditivos. En `approval.resolved` de
`hu_review` / `feasibility_partial`, `proposalHash` lleva el `decisionHash`
decidido. Orden observado: `approval.resolved` se emite DESPUÉS de los eventos
de la ejecución reanudada (etapas, nueva `approval.required`, `execution.*`).
| `assistant.message` | `{ taskId, status, summary }` |
| `knowledge.proposed` | `{ docId, title, category }` |

`data` NO contiene secretos, tokens ni stderr crudo (el Core sanea antes de
publicar; verificado por test).

## 3. Bus de eventos (`src/events/event-bus.ts`)

`EventBus.publish(event)` / `subscribe(fn) → unsubscribe`. AISLAMIENTO: si un
suscriptor lanza, el error se captura (`onSubscriberError`) y NO detiene el Core
ni afecta a los demás suscriptores. La publicación no bloquea la ejecución.

El bus solo distribuye en vivo; la persistencia la hace el `EventStore`.

## 4. Persistencia y reconexión (`src/events/event-store.ts`)

SQLite (reutiliza `better-sqlite3`, sin deps nuevas). `append` asigna `seq` por
ejecución; `getSince(executionId, afterSeq)` devuelve los posteriores (para
reconectar). Retención: máximo `maxPerExecution` eventos por ejecución (se
descartan los más antiguos). Si un cliente pide eventos anteriores a los
disponibles (brecha por retención), el endpoint SSE envía un evento de control
`gap` y sirve desde el más antiguo disponible.

Idempotencia al reanudar: el Core recuerda el último estado de cada etapa
(`lastStageStatus`) y solo emite transiciones nuevas. Una ejecución reanudada
desde SQLite NO vuelve a publicar etapas ya emitidas.

## 5. Endpoint SSE

`GET /executions/:executionId/events`

- 404 si la ejecución no existe; 501 si el servidor no tiene eventos configurados.
- `Content-Type: text/event-stream`. Formato estándar `id:`/`event:`/`data:`.
- Reconexión: envía el historial posterior a `Last-Event-ID` (header estándar) o
  `?lastEventId=`, y luego los eventos nuevos en vivo.
- Heartbeat periódico (`: ping`) para mantener viva la conexión.
- Al desconectarse el cliente (`req`/`res` close): desuscribe y limpia el timer.
  Una desconexión NUNCA interrumpe la ejecución.
- (Estabilización) Eventos de control: `{"kind":"gap"}` (eventos fuera de la
  retención), `{"kind":"end","reason":"terminal","lastSeq"}` (ejecución
  definitiva: se envía tras el historial o tras el evento terminal en vivo y el
  servidor cierra el stream; el cliente no debe reconectar) y
  `{"kind":"shutdown"}` (el servidor se apaga y cierra el stream).
- (Estabilización) Al apagar (`close()` / Ctrl+C), el servidor avisa a cada
  cliente, cierra los streams y las conexiones: el cierre ya no queda colgado con
  clientes abiertos. `serve.ts` tiene un plazo máximo de 5 s.
- (Estabilización) Emisión idempotente entre reinicios: lo ya emitido por etapa,
  el último `approval.required` y el evento terminal se reconstruyen del
  `EventStore`; tras reiniciar no se re-emiten eventos publicados.

## 6. Ejemplo de consumo

Con `curl` (streaming):

```bash
# Suponiendo una ejecución <threadId> ya iniciada (ver docs/API.md).
curl -N http://127.0.0.1:4123/executions/<threadId>/events

# Reconexión desde el último id visto (p. ej. 3):
curl -N -H 'Last-Event-ID: 3' http://127.0.0.1:4123/executions/<threadId>/events
```

Salida (ejemplo):

```
: ok

id: 1
event: execution.started
data: {"eventId":"...","type":"execution.started","executionId":"dev-...","seq":1,"data":{"phase":"approved","status":"..."}}

id: 2
event: stage.completed
data: {"type":"stage.completed","seq":2,"data":{"stageId":"hu_analysis","label":"Análisis de HU"}}

id: 3
event: approval.required
data: {"type":"approval.required","seq":3,"data":{"kind":"hu_review"}}

: ping 1730000000000
```

En un navegador (futura UI, no incluida):

```js
const es = new EventSource(`/executions/${threadId}/events`);
es.addEventListener("stage.completed", (e) => console.log(JSON.parse(e.data)));
es.addEventListener("approval.required", (e) => console.log("aprobar:", JSON.parse(e.data)));
// EventSource reenvía automáticamente Last-Event-ID al reconectar.
```

## 7. Compatibilidad

Los endpoints REST de la Fase 19 siguen intactos; `ExecutionView` sigue siendo
compatible (se añadió solo el campo reservado `events?`). La UI futura usará REST
para consultas/acciones y SSE para actualizaciones. No se introdujo WebSocket.

## 8. Pruebas

- `src/events/events.test.ts` (6): aislamiento del bus, seq por ejecución,
  getSince, retención, eventos sin executionId.
- `src/api/sse.test.ts` (10): emisión real en desarrollo/aprobación/asistencia/
  conocimiento, cliente SSE en vivo, reconexión con Last-Event-ID, desconexión
  que no interrumpe, sin duplicar al reanudar, sin exponer secretos, 404.

Suite completa: 237 tests en 27 archivos (fases 1-19 verdes).

## 9. Limitaciones

- Granularidad de `stage.*` = la del `ExecutionView` (derivada del estado tras
  cada reanudación), no por cada nodo interno del grafo. Es honesta: no se
  instrumenta el grafo.
- Sin streaming de tokens del modelo (fuera de alcance).
- `assistant.message` y `knowledge.proposed` no tienen `executionId` (son de
  sesión/globales): se publican en vivo por el bus pero no se indexan por
  ejecución en el store.

## 10. Archivos de esta fase

- `src/events/event-types.ts` — contrato de eventos.
- `src/events/event-bus.ts` — bus desacoplado.
- `src/events/event-store.ts` — persistencia + reconexión.
- `src/core/saiki-core.ts` — emisión desde puntos reales.
- `src/api/http-server.ts` — endpoint SSE.
- `src/events/events.test.ts`, `src/api/sse.test.ts` — pruebas.
