# Fase 21 — Propuesta frontend de Jev (pendiente de aprobación)

> Respuesta a `docs/handoffs/claude-frontend-handoff.md`. Solo propuesta: no hay
> código en `web/` todavía. Concepto visual (datos ilustrativos):
> https://claude.ai/artifact/9eHdod2LHmqjB1itpJvz7p

## 1. Verificación del handoff contra el código

Revisados `src/api/http-server.ts`, `src/api/serve.ts`, `src/core/saiki-core.ts`,
`src/core/execution-view.ts`, `src/events/event-types.ts` y
`src/api/http-server.test.ts`, y probado `npm run serve` (Node 22) con `curl`.

Endpoints, tipos y eventos de §3–§5 coinciden con el código. Diferencias y
matices que cambian el diseño:

| # | Hallazgo | Evidencia | Consecuencia para la UI |
|---|---|---|---|
| 1 | ~~Toda ejecución creada por la API se detiene en `hu_review` y no puede avanzar por HTTP.~~ **Resuelto en la mini-fase backend 21**: `POST /executions/:id/approval/:kind` (`hu_review`, `feasibility_partial`) con `decisionHash`. Ver `docs/API.md` §5.1. | `src/api/gates.test.ts` | Jev resuelve las tres puertas: HU, viabilidad parcial y propuesta. |
| 2 | `POST /sessions/:id/messages` y `POST /approval` **bloquean hasta que el grafo se pausa o termina** (minutos con Kiro/Claude reales; aprobar incluye aplicar y verificar). | `saiki-core.ts:210`, `:527` | Estados de espera largos con tiempo transcurrido; no hay cancelación en servidor. |
| 3 | Los eventos se emiten **al terminar cada `invoke`**, por diff, no por nodo. El SSE llega en ráfagas con el mismo timestamp. | `saiki-core.ts:214`, `:483`, `:632` | El SSE no da progreso en vivo durante una etapa ni sirve para medir duraciones. |
| 4 | Durante un `invoke`, `GET /executions/:id` lee el último checkpoint de SQLite, y la sesión se guarda enlazada al thread **antes** del `invoke`. | `saiki-core.ts:206-210`, `:424-430` | Sondear REST mientras hay una petición en curso muestra progreso real por etapa. **Verificado** con agentes reales el 2026-10-30 (`PROJECT_MEMORY.md` §3.20). |
| 5 | Los heartbeats `: ping` son comentarios SSE: `EventSource` no los expone a JS. | `http-server.ts:364-366` | El indicador muestra el estado de conexión (`readyState`), no los latidos. |
| 6 | Proxyar `/sessions` y `/executions` (handoff §9) choca con las rutas de la SPA: recargar `/sessions/abc` devolvería JSON. | — | El cliente usa el prefijo `/api`, que el proxy de Vite reescribe. |
| 7 | `POST /sessions` **no persiste** la sesión; solo devuelve un id. Aparece en `GET /sessions` tras el primer mensaje. | `http-server.ts:127-134`, probado | No se muestra una sesión "creada" hasta enviar el mensaje. |
| 8 | El diff de etapas vive en memoria: si el backend se reinicia, re-emite eventos de etapas ya publicadas (con `seq` nuevo). `approval.required` se re-emite en cada observación con aprobación pendiente. | `saiki-core.ts:151`, `:610-662` | El registro tolera duplicados; el estado del pipeline nunca se deriva de eventos. |
| 9 | `status: "running"` no siempre significa ejecución activa: `final_approval` queda `running` mientras espera al humano, y las revisiones rechazadas quedan `running` al volver a desarrollo. | `execution-view.ts:194-213` | `running` + `pendingApproval` se pinta como "Espera tu decisión"; el pulso solo se usa con una petición en curso. |
| 10 | No hay endpoint de lista de ejecuciones. Cada sesión tiene como mucho un `developmentThreadId`, que se reutiliza. | `saiki-core.ts:204` | Las ejecuciones se descubren desde `GET /sessions`. |
| 11 | No hay CORS: `OPTIONS` responde 404. | probado | Proxy de desarrollo obligatorio (confirmado). |
| 13 | ~~`status` "esperando interacción" durante la ejecución.~~ **Resuelto (estabilización)**: `ExecutionView.lifecycle`, `activity`, `activeStage`, `awaitingDecision`; `status` se redacta desde el ciclo de vida. Jev ya no deduce estados. | `src/core/execution-lifecycle.ts` | Jev usa `lifecycle` para actividad, sondeo y textos, y `awaitingDecision` para la señal y la etapa en espera. |
| 14 | ~~Ctrl+C colgado con clientes SSE.~~ **Resuelto (estabilización)**: el servidor cierra los streams al apagar (`control: shutdown`), envía `control: end` en ejecuciones definitivas y no duplica eventos tras reiniciar. | `src/api/http-server.ts`, `src/api/serve.ts` | Jev cierra el `EventSource` con `end` ("Eventos: Finalizada"). |
| 15 | ~~La API no devolvía los archivos de una propuesta resuelta.~~ **Resuelto (estabilización)**: `GET /executions/:id/proposals` y `/decisions`, historial inmutable. | `src/core/core-store.ts` | El resultado final usa el historial del backend (se eliminó el registro de "propuestas vistas por la pestaña"). |
| 0 | (Estabilización) Un mensaje de desarrollo reutilizaba el hilo de la sesión: reiniciaba ejecuciones pausadas y reactivaba terminadas. **Resuelto**: una ejecución por solicitud (`developmentThreadIds`). | `src/core/saiki-core.ts` | El inicio y la columna lateral muestran una fila por ejecución; la sesión lista todas sus ejecuciones y permite pedir otro desarrollo. |
| 12 | El backend necesita Node 22 (`nvm use 22`); el Node por defecto de la máquina es 20. | probado | Documentarlo en el README de `web/`. |

No comprobado: qué ocurre al enviar otro mensaje a una sesión con una ejecución
pausada (`process` reinvoca el mismo thread con `{ request }`, no con
`Command({ resume })`). La UI no lo ofrecerá como forma de desbloquear nada.

## 2. Arquitectura

```
web/                          sub-proyecto independiente (no importa de src/)
  package.json                dependencias propias, versiones exactas
  vite.config.ts              proxy /api → http://127.0.0.1:4123 (rewrite sin /api), dev y preview
  index.html
  src/
    main.tsx, App.tsx         router + QueryClientProvider
    api/
      types.ts                contratos copiados de §4 del handoff
      client.ts               fetch tipado; ApiError { status, code, message, expectedHash? }
      events.ts               EventSource por ejecución: listeners por tipo, lastSeq, estado de conexión
    hooks/
      useExecution.ts         GET /executions/:id + invalidación por SSE + sondeo con petición en curso
      useApproval.ts          GET/POST /approval, manejo de 409
      useSessions.ts          GET /sessions, /sessions/:id, POST mensajes
    routes/                   HomePage, SessionPage, ExecutionPage, KnowledgePage
    components/               Pipeline, Station, StageInspector, GateBanner, ApprovalDialog,
                              EventLog, SessionRail, Composer, ConnectionStatus,
                              ResultSummary, Unavailable
    styles/tokens.css         variables CSS (sección 4); componentes con CSS Modules
```

Dependencias: `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`,
`@fontsource/overpass`, `@fontsource/overpass-mono` (fuentes locales, sin CDN).
Desarrollo: `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react*`,
`vitest`, `@testing-library/react`. Sin Tailwind, sin librería de componentes,
sin store global: iconos SVG propios (son pocos).

Reglas de datos:
- **La verdad es `GET /executions/:id`.** Cada evento SSE añade una línea al
  registro e invalida esa consulta. El frontend no calcula estados de etapa.
- Mientras haya un `POST` de esta pestaña en curso, se sondea `GET /sessions/:id`
  (para descubrir el `developmentThreadId`) y `GET /executions/:id` cada ~2 s.
  (Hallazgo 4 verificado con agentes reales.)
- Fuera de eso: SSE + refetch al recuperar el foco. Sin sondeo permanente.
- `executionId = HandleResult.developmentThreadId`. Nunca se envía `actorId`.

## 3. Navegación

| Ruta | Contenido | Endpoints |
|---|---|---|
| `/` | Composer de nueva solicitud; "Necesitan tu intervención" (ejecuciones con `pendingApproval.required`); "Recientes" | `GET /sessions`, `GET /executions/:id` por sesión con thread, `POST /sessions`, `POST /sessions/:id/messages` |
| `/sessions/:sessionId` | Conversación (turnos), tareas de asistencia (`runtime`, `agentRole`, `synthesis`, evidencias), enlace a la ejecución | `GET /sessions/:id` |
| `/executions/:executionId` | **Pantalla protagonista**: pipeline, aviso de decisión, inspector de etapa (`?stage=<id>` enlazable), registro de eventos y, si es terminal, resultado | `GET /executions/:id`, SSE, `/approval`, `/result` |
| `/knowledge`, `/knowledge/:id` | Búsqueda y lectura de la KB (solo lectura) | `GET /knowledge` |

Cabecera fija: marca, Sesiones, Conocimiento, estado de la API (`/health`).
En escritorio, la ejecución lleva a la izquierda una columna con las sesiones
recientes. El diálogo de aprobación se abre desde el aviso, nunca solo.

## 4. Sistema visual

Dirección: **panel de mando ferroviario** (un cuadro de señales). Saiki-IA
encamina un trabajo por una vía de etapas con puntos de control humanos. La
metáfora encaja con la semántica real (secuencia, señales que bloquean,
autorización atada a una versión). No se usa como decoración.

**Color** (paleta azul oscuro aprobada el 2026-10-30; sustituye a la de azul petróleo.
Fuente de verdad: `web/src/styles/tokens.css`, con los contrastes medidos)

| Token | Hex | Uso |
|---|---|---|
| `--color-ground` | `#080D18` | fondo |
| `--color-surface` | `#111827` | paneles |
| `--color-raised` | `#1E293B` | selección, hover |
| `--color-border` / `--color-border-strong` | `#334155` / `#64748B` | separadores / límites de controles (≥3:1) |
| `--color-text` / `--color-text-2` | `#F8FAFC` / `#94A3B8` | texto |
| `--color-primary` | `#2563EB` | acción principal (fondo, con texto `#F8FAFC`: 4,9:1) |
| `--state-pending` | `#64748B` | pendiente (solo formas: 4,1:1) |
| `--state-running` | `#38BDF8` | en curso / actividad |
| `--state-done` | `#22C55E` | completada (tramo recorrido `#15803D`) |
| `--state-failed` | `#EF4444` | error (texto sobre `raised`: `#F87171`) |
| `--state-awaiting` | `#F59E0B` | requiere tu decisión (fondo de aviso `#2A1F08`) |
| `--state-skipped` | `#475569` | omitida (2,6:1: siempre con etiqueta y forma) |

Cada estado cambia también de forma (check, anillo, rombo, aspa, anillo
discontinuo, punto) y lleva etiqueta: nunca depende solo del color.

**Tipografía**: Overpass (interpretación libre de la tipografía de señalización
vial Highway Gothic) para la interfaz, y Overpass Mono **solo** para
identificadores reales: ids, hashes, rutas, tipos de evento y fases. Escala:
26/17/15/13; texto de 15 con interlineado 1,5; títulos en sentence case, sin
etiquetas en mayúsculas.

**Espaciado y forma**: escala de 4 px; radios de 6 en controles, 8 en paneles
y 10 en diálogos. Sin sombras ni gradientes: la profundidad la dan superficie y
borde. Movimiento: solo en respuesta a acciones y para el pulso de "en curso"
real; respeta `prefers-reduced-motion`.

**Componentes y estados**: Station (7 estados + seleccionada + foco),
GateBanner, ApprovalDialog (`role="dialog"`, foco atrapado, Escape cierra sin
decidir), EventLog (`role="log"`), ConnectionStatus (conectado, reconectando,
sin conexión, SSE no disponible 501), `Unavailable` (forma única de mostrar
"No disponible" con su motivo), y vacíos y errores con instrucciones.

## 5. Concepto del pipeline y del dashboard

```
┌ Saiki-IA   Sesiones  Conocimiento                         ● API conectada ┐
├──────────────┬────────────────────────────────────────────────────────────┤
│ Nueva        │ Implementa un util de suma que valide enteros               │
│ solicitud    │ Ejecución dev-7f3c…  Sesión sess-k2m9  Ciclos 1  En curso   │
│              │                                                             │
│ ▸ sesión 1   │  1     2     3     4     5     6     7     8     9          │
│   sesión 2   │  ●━━━━━●━━━━━●━━━━━●━━━━━●━━━━━●━━━━━◆─────○─────○          │
│   sesión 3   │  HU   Técn. Viab. Desar. Func. Cal.  Aprob. Aplic. Verif.   │
│              │                                                             │
│              │ ◆ Necesita tu decisión: aprobación final   [Revisar propuesta]
│              │ ┌ 4. Desarrollo ───────────┐ ┌ Registro de eventos ── ● ──┐ │
│              │ │ Detalle  …               │ │ 10 10:58 approval.required  │ │
│              │ │ Agente   No disponible   │ │  9 10:58 stage.started      │ │
│              │ │ Duración No disponible   │ │  …                          │ │
│              │ └──────────────────────────┘ └─────────────────────────────┘ │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- El pipeline ocupa todo el ancho; es el único elemento con presencia visual
  fuerte. El tramo recorrido se ilumina y el tramo hacia una señal pendiente va
  en ámbar.
- `hu_review` y `feasibility_partial` no son etapas: se dibujan como una señal
  en la vía tras la etapa 1 o la 3, derivada de `pendingApproval.kind`.
- Inicio: lista con separadores, no tarjetas; cada fila lleva una mini-vía de
  9 tramos con su descripción accesible.
- Móvil: la vía pasa a vertical, y el inspector y el registro se apilan.

## 6. Limitaciones del handoff, sin inventar

| Limitación | Cómo se resuelve |
|---|---|
| Agente/runtime por etapa | Fila "Agente y runtime: No disponible" con su motivo. No se deduce de `serve.ts`. Las tareas de asistencia sí muestran `runtime` y `agentRole`. |
| Duración por etapa | "No disponible". No se derivan de eventos SSE (llegan en ráfaga, hallazgo 3). Si el sondeo (hallazgo 4) funciona, se podría mostrar "observado durante ≈ X" solo para lo visto en vivo en esta pestaña. Decisión tuya. |
| Aprobación de HU / viabilidad parcial | Resuelto (backend 21): señal ámbar + diálogo con `gate` (HU o motivos de viabilidad) y las decisiones de `gate.allowedDecisions`. |
| `assistant.message` / `knowledge.proposed` | Se leen por REST (`/sessions/:id`, `/knowledge`) al cargar y al terminar un `POST`. |
| Sin CORS | Proxy `/api` de Vite (dev y `vite preview`). Producción detrás del mismo origen: fuera de alcance. |
| Identidad única | No se envía actor; se muestra el `actor` que devuelve `ApprovalResolution`. |
| 409 `hash_mismatch` | Se recarga `/approval`, se muestra la nueva versión y se exige decidir de nuevo. Nunca se reenvía solo. |
| 409 `not_awaiting` | "Esta ejecución ya no espera una decisión" y se refresca la vista. |

## 7. Plan de implementación (tras aprobación)

Los pasos 1–8 de §11 del handoff, cada uno verificado contra `npm run serve`:

1. Esqueleto (`web/`, proxy `/api`, `/health`, tokens y fuentes). **Hecho
   2026-10-30**, pendiente de revisión. Añadido `@types/node` (solo tipos de
   desarrollo, para los tests con servidor HTTP real). React Router 8:
   `RouterProvider` se importa de `react-router/dom`.
2. Tipos y cliente, más la lista de sesiones. **Hecho 2026-10-30** (con el 3),
   pendiente de revisión: inicio (solicitud, intervención, recientes), sesión
   (conversación, tareas de asistencia con rol/runtime).
3. Vista de ejecución por REST. **Hecho 2026-10-30**: pipeline de 9 estaciones,
   señales HU/viabilidad, sondeo cada 2,5 s solo con actividad. Verificado con
   una solicitud real enviada desde la UI (Claude + Kiro): la misma página pasó
   de "Análisis de HU en curso" a la pausa en `hu_review` sin recargar.
4. Inspector de etapa. **Hecho 2026-10-30**: estaciones seleccionables
   (teclado, `aria-pressed`, `?stage=`), detalle, agente/runtime y errores con
   su motivo cuando no hay dato, y «Tiempo observado» solo con inicio y fin vistos
   por el sondeo de esta pestaña (nunca SSE). Los eventos por etapa se añaden
   con el registro SSE del paso 5.
5. SSE y estado de conexión. **Hecho 2026-10-30**: registro de eventos (sin
   duplicados, orden por `seq`, aviso de brecha), invalidación de la vista por
   evento, anuncio accesible de eventos importantes en vivo, reconexión con espera
   creciente desde el último `seq`. Verificado en real: eventos en vivo con
   agentes reales y caída/relanzamiento del backend sin duplicar eventos.
   Corregido en `web/vite.config.ts`: el proxy de Vite no cerraba el stream SSE
   cuando el backend caía.
6. Diálogos de decisión (HU, viabilidad parcial, propuesta) con manejo de 409.
   **Hecho 2026-10-30**: `<dialog>` modal que congela la versión mostrada y
   decide con su hash; confirmación en decisiones irreversibles; observaciones
   obligatorias al pedir cambios. Verificado en real solo por la UI: pedir
   cambios, 409 `hash_mismatch` con dos pestañas, versión 2, viabilidad parcial,
   aprobar y aplicar (`applied`), rechazar HU (`rejected`) y "No desarrollar"
   (`blocked`). «Tiempo observado» real: análisis técnico ≈ 47 s (±5 s) con la
   pestaña oculta (el sondeo con actividad sigue en segundo plano).
7. Resultado final. **Hecho 2026-10-30**: desenlace (textos de `docs/APPLY.md`),
   aplicación y verificación, revisiones, decisiones humanas (eventos
   `approval.resolved`) y archivos (ver hallazgo 15). Etapas `pending` de una
   ejecución terminada se rotulan "No se ejecutó". Verificado con las ejecuciones
   reales (`applied`, `rejected`, `blocked`) y un flujo real completo (`isEven`)
   cuyos archivos coinciden con la versión aprobada.
8. Pulido: responsive, vacíos y errores; `accessibility-scan` y
   `accessibility-inspect` sobre la app en ejecución. **Hecho 2026-10-30**: vista
   de Conocimiento (solo lectura, filtros en la URL). AccessLint (WCAG 2.2 AA)
   sobre 7 pantallas reales: 2 violaciones (`aria-allowed-role` en el registro,
   `landmark-unique` por errores duplicados), corregidas y re-escaneadas a 0. El
   diálogo (que la CLI no puede abrir) se revisó a mano por teclado: foco al
   abrir, foco contenido, Escape devuelve el foco; corregido el foco al pedir
   confirmación (va a "Volver"). Responsive revisado a 375 px.

## 8. Decisiones pendientes

1. ~~Hallazgo 1~~: resuelto con la mini-fase backend 21.
2. Aprobar o ajustar la dirección visual (petróleo + señales, Overpass).
3. Mostrar o no tiempos "observados" si el sondeo funciona.
4. Instalar `vercel-react-best-practices` ahora que el stack es React (estaba
   pendiente según `.claude/skills/README.md`).
