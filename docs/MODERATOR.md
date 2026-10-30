# Fase 16 — Moderador conversacional inteligente

> Nombre oficial: `saiki-ia`. Evoluciona el moderador determinista (Fase 14) a
> uno basado en un modelo de lenguaje, manteniéndolo INDEPENDIENTE del proveedor.

## 1. Diagnóstico previo

- La integración de Fase 15 (`SaikiCore`) ya inyecta el moderador
  (`options.moderator`) y enruta conversation/assistance/development. Cambiar el
  moderador NO obliga a tocar el Core.
- `ModeratorSession.turns[]` ya guardaba el historial conversacional: es la base
  del contexto entre mensajes (no se duplica infraestructura).
- `ClaudeCliAdapter` ya usa un `ProcessRunner` inyectable con flags de solo
  texto; se reutiliza ese mecanismo para el motor conversacional.
- Ajuste necesario (menor, aditivo): el contrato `Moderator` era SÍNCRONO; un
  moderador con LLM es ASÍNCRONO. Se añadió `AsyncModerator` sin romper el
  síncrono, y el Core acepta ambos.

## 2. Arquitectura

```
  Usuario
    │
    ▼
┌──────────────────┐   classifyAsync / respond   ┌──────────────────────────┐
│   LlmModerator    │ ──────────────────────────► │  RichClassification       │
│ (AsyncModerator)  │                             │  intent/confidence/...    │
└──────────────────┘                             └──────────────────────────┘
    │ usa
    ▼
┌──────────────────────┐   complete(prompt)        proveedor intercambiable
│ ConversationEngine    │ ─────────────────────►  ClaudeConversationEngine
│ (abstracción)         │                          (reutiliza ProcessRunner)
└──────────────────────┘
    │ decisión (reply / clarify / delegate / start development)
    ▼
┌──────────────────────────  SaikiCore  ───────────────────────────────────────┐
│  conversation → reply     assistance → delegación (solo lectura)              │
│  clarification → pregunta development → grafo (con aprobaciones humanas)       │
└───────────────────────────────────────────────────────────────────────────────┘
```

- `ConversationEngine` (`src/moderator/conversation-engine.ts`): contrato del
  RUNTIME conversacional. Un proveedor nuevo = una clase que lo implemente.
- `ClaudeConversationEngine` (`src/moderator/claude-conversation-engine.ts`):
  primer proveedor. Reutiliza `spawnProcessRunner` con flags de SOLO TEXTO
  (`-p --tools "" --restricted --strict-mcp-config --disallowedTools Write Edit
  Bash`), prompt por stdin. Separado del rol `develop`. Límites de timeout y
  tope de bytes configurables. NUNCA simula salida si falla.
- `LlmModerator` (`src/moderator/llm-moderator.ts`): implementa `AsyncModerator`.

## 3. Comprensión de solicitudes

`classifyAsync()` arma un prompt con el HISTORIAL reciente de la sesión + un
esquema estricto, y pide al modelo un JSON tipado `RichClassification`:

- `intent`: conversation | assistance | development | clarification
- `confidence` (0..1), `reason`, `missingInfo[]`, `recommendedAction`,
  `proposedFlow`, `clarifyingQuestion?`

El JSON se valida (`parseClassification`): tolera envoltura en markdown, exige un
`intent` válido y clampa la confianza. Si el modelo falla o devuelve algo no
parseable, se lanza `ModeratorEngineError` (error EXPLÍCITO; no se simula nada).

**La confianza NO autoriza acciones sensibles**: aunque sea 0.99, el moderador
solo PROPONE; el Core aplica las reglas y las aprobaciones humanas.

## 4. Contexto conversacional

El contexto se mantiene en `session.turns[]` (ya existente). `renderHistory()`
incluye los últimos turnos en el prompt, lo que permite:
- resolver referencias a mensajes anteriores ("¿y eso cómo se prueba?"),
- incorporar aclaraciones del usuario,
- corregir una interpretación previa ("mejor solo investiga").

Cada sesión es independiente (su propio `sessionId`), persistida por `CoreStore`.

## 5. Coordinación (qué hace con cada intención)

- **conversation** → redacta una respuesta (`writeReply`), sin delegar ni
  desarrollar.
- **assistance** → el Core crea una `DelegatedTask` de SOLO LECTURA y la ejecuta
  (OpenCode). El moderador puede sintetizar el resultado (`synthesizeAssistance`).
- **development** → marca `startDevelopment`; el Core arranca el grafo, que
  conserva las aprobaciones humanas y el Safe Applier.
- **clarification** → devuelve una pregunta; el Core NO ejecuta nada.

El moderador NO duplica la lógica de ejecución: solo propone; el Core ejecuta.

## 6. Respuestas y síntesis

`synthesizeAssistance(task)` resume el resultado real de una investigación,
pidiendo al modelo diferenciar HECHOS / HIPÓTESIS / RECOMENDACIONES y conservando
la referencia al `task.id`. Si la tarea falló, NO inventa un resultado.

## 7. Seguridad (no debilitada)

El `LlmModerator` NO expone ningún método para modificar el repo, aplicar
propuestas, aprobar código o conocimiento, ni cambiar estados de ejecución. Todo
eso sigue en el Core/grafo/KB con sus controles. El motor conversacional corre en
modo solo texto (sin herramientas de escritura/ejecución).

## 8. Cambiar de proveedor

Implementar otro `ConversationEngine` (p. ej. `OtroProveedorEngine`) e inyectarlo:
`new LlmModerator(new OtroProveedorEngine())`. El Core NO cambia. Probado en
`saiki-core.test.ts` (escenario 10): dos engines distintos producen el mismo
enrutamiento sin tocar el Core.

## 9. Pruebas

- `src/moderator/llm-moderator.test.ts` (15): escenarios 1-9 del enunciado +
  síntesis + "confianza no cambia reglas" + robustez de `parseClassification`.
- `src/core/saiki-core.test.ts` (+4): development async con aprobaciones,
  clarification no ejecuta, cambio de proveedor sin tocar el Core, error del
  proveedor propagado.

Deterministas con un `ConversationEngine` falso; no dependen de Claude real.
Suite completa: 199 tests en 24 archivos (fases 1-15 siguen verdes).

## 10. Demostración manual (opt-in)

`npm run manual:moderator` ejecuta el moderador con Claude REAL integrado en el
Core, recorriendo una conversación multi-turno (consulta → investigación →
mensaje ambiguo → desarrollo). El desarrollo queda pausado esperando aprobación;
la aplicación va a una copia temporal salvo `SAIKI_APPLY_TO_REAL_REPO=1`.

## 11. Limitaciones / pendientes

- El clasificador depende de la calidad del modelo; por eso el JSON se valida y
  ante la duda se usa `clarification` en vez de forzar un desarrollo.
- No hay streaming ni memoria de largo plazo entre sesiones (el contexto es por
  sesión). La KB cubre el conocimiento persistente del equipo.
- Jev no se construyó (solo la fachada `JevCorePort`).
- Recuperación semántica de la KB: preparada, no implementada.

## 12. Archivos de esta fase

- `src/moderator/conversation-engine.ts` — contrato del motor conversacional.
- `src/moderator/claude-conversation-engine.ts` — proveedor Claude (texto).
- `src/moderator/llm-moderator.ts` — moderador conversacional.
- `src/moderator/moderator-types.ts` — `AsyncModerator` + `RichClassification`.
- `src/core/saiki-core.ts` — acepta el moderador async (sin cambiar reglas).
- `src/manual/moderator-integration.ts` — demo opt-in (`npm run manual:moderator`).
