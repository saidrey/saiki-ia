# Fase 17 — Síntesis de asistencia integrada en el Core

> Nombre oficial: `saiki-ia`. Cierra el ciclo de asistencia: cuando una
> investigación termina bien, el Core pide automáticamente su síntesis al
> moderador y entrega al usuario una respuesta natural y fundamentada.

## 1. Diagnóstico previo

- La rama de asistencia de `SaikiCore.process` ya ejecutaba `runDelegatedTask`
  (OpenCode, solo lectura) y devolvía la tarea cruda, SIN sintetizar.
- `synthesizeAssistance(task)` ya existía en `LlmModerator` (Fase 16): diferencia
  hechos/hipótesis/recomendaciones, conserva la referencia al `task.id` y no
  inventa si la tarea falló.
- Incompatibilidad menor: `synthesizeAssistance` no estaba en ningún contrato,
  era un método "extra" de `LlmModerator`. El Core tiene `moderator: Moderator |
  AsyncModerator` y no podía invocarlo sin un chequeo.

Solución (aditiva, sin tocar contratos fundamentales):
- Interfaz OPCIONAL `AssistanceSynthesizer { synthesizeAssistance(task) }`.
- Campo aditivo `DelegatedTask.synthesis?: string` (idempotencia).
- Type-guard `canSynthesize(moderator)` en el Core.

## 2. Flujo de asistencia (cerrado)

```
  Usuario: "investiga X"
    │
    ▼  moderador clasifica → assistance
┌──────────────────────── SaikiCore (rama assistance) ─────────────────────────┐
│ 1. createDelegatedTask (SOLO LECTURA: read_repo, read_kb, external_docs)       │
│ 2. runDelegatedTask → OpenCode (nunca apply_changes)                          │
│ 3a. si FALLÓ  → reply "no se completó" + errors (SIN síntesis)                │
│ 3b. si OK     → trySynthesize(task):                                          │
│        · si task.synthesis ya existe → reutiliza (idempotente)                │
│        · si el moderador soporta síntesis → synthesizeAssistance(task)        │
│        · si no la soporta → resultado CRUDO + nota                            │
│        · si la síntesis FALLA → resultado CRUDO + error (no se pierde)        │
│ 4. persiste task.synthesis + turno del moderador + sesión                     │
│ 5. reply = síntesis (o crudo según el caso)                                   │
└───────────────────────────────────────────────────────────────────────────────┘
    │
    ▼  respuesta natural al usuario, con contexto conversacional conservado
```

## 3. Calidad de la síntesis

`synthesizeAssistance` (en `LlmModerator`) pide al modelo diferenciar
explícitamente HECHOS / HIPÓTESIS / RECOMENDACIONES y conservar las fuentes si
las hay, partiendo SOLO del `task.result` real (no inventa). La respuesta final
añade `[síntesis basada en el resultado de la tarea <id>]` para trazabilidad.

Si la tarea no produjo resultado (falló), devuelve un mensaje explícito y no
sintetiza nada.

## 4. Manejo de errores (robustez)

| Situación | Comportamiento |
|-----------|----------------|
| La investigación falla (`status=failed`) | Se comunica el error; NO hay síntesis; no se presenta como exitosa. |
| La síntesis falla (motor caído) | Se CONSERVA el resultado crudo + se avisa; no se pierde la investigación. |
| El moderador no soporta síntesis (determinista) | Resultado crudo + nota "sin sintetizar" (degradación honesta). |
| Ejecución recuperada con `synthesis` ya presente | NO se re-sintetiza (idempotencia). |

## 5. Seguridad (no debilitada)

- OpenCode (asistencia) sigue en SOLO LECTURA; nunca `apply_changes`.
- El moderador no modifica archivos, no aplica, no aprueba (código ni KB).
- No se tocó el Safe Applier ni el flujo de desarrollo.
- No se introdujeron aprobaciones automáticas.

## 6. Pruebas

`src/core/saiki-core.test.ts` (bloque Fase 17, 9 tests):
1. Investigación exitosa → síntesis automática.
2. La síntesis conserva la referencia original (`task.id`).
3. Una consulta que no requiere investigación NO dispara síntesis.
4. Fallo del runtime comunicado (sin falso éxito).
5. Fallo de síntesis conserva el resultado de investigación.
6. Ejecución recuperada no re-sintetiza (idempotencia, SQLite real).
7. La respuesta final conserva el contexto conversacional.
8. Los escenarios de desarrollo mantienen sus garantías.
+ Moderador sin síntesis entrega el crudo con nota.

Deterministas con un `ConversationEngine` falso. Suite completa: 208 tests en 24
archivos (fases 1-16 siguen verdes).

## 7. Demostración manual (opt-in)

`npm run manual:moderator` ahora muestra, en el turno de investigación, la
SÍNTESIS automática (o el resultado crudo si el proveedor no está disponible).

## 8. Limitaciones / pendientes

- `DelegatedTask.evidence[]` existe en el contrato pero `runDelegatedTask` aún no
  la puebla (OpenCode devuelve texto); la síntesis parte de `task.result`. Si en
  el futuro el runtime entrega evidencias estructuradas, la síntesis podría
  citarlas con más precisión.
- La síntesis depende de la calidad del modelo; por eso parte solo del resultado
  real y nunca inventa.

## 9. Archivos de esta fase

- `src/core/saiki-core.ts` — rama de asistencia con síntesis automática + `trySynthesize`.
- `src/moderator/moderator-types.ts` — `AssistanceSynthesizer` (opcional).
- `src/moderator/delegation.ts` — `DelegatedTask.synthesis?` (aditivo).
- `src/core/saiki-core.test.ts` — 8 escenarios de aceptación + extra.
- `src/manual/moderator-integration.ts` — demo muestra la síntesis.
