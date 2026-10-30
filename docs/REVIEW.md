# Fase 8 — Revisión estructurada (simulada)

El rol `review` pasa de un booleano a una **revisión estructurada**: aprueba o
rechaza con hallazgos, y un rechazo activa un ciclo de corrección limitado.

> El revisor sigue SIMULADO. NO usa un modelo ni hace análisis semántico real;
> aplica reglas deterministas. El objetivo es validar el FLUJO
> revisión→corrección→aprobación antes de introducir un revisor real.

## Contrato (`src/review/review-types.ts`)

```
ReviewResult {
  status:   "success" | "failure"   // éxito/fallo de EJECUCIÓN de la revisión
  decision: "approved" | "rejected" // sólo significativo si status=success
  findings: Finding[]               // { id, severity, description }
  summary:  string
  error?:   string
}
```

Distinción clave: `status: "failure"` (la revisión falló) es DISTINTO de
`decision: "rejected"` (revisión OK que rechaza). `coerceReviewResult` valida
resultados no confiables y **nunca interpreta un inválido como aprobación**.

El contrato `Reviewer` está aislado del grafo: mañana se sustituye el mock por
un revisor real sin tocar nodos ni aristas.

## Revisor simulado (`src/review/mock-reviewer.ts`)

Reglas configurables (honestas, no finge IA):
- `rejectUntilAttempt`: nº de intentos que rechaza antes de aprobar
  (`0`=aprueba ya, `1`=rechaza 1º y aprueba 2º, `99`=nunca aprueba).
- `failExecution`: la revisión falla (error de ejecución).
- `findingsOnReject`: hallazgos a reportar.

## Flujo (REORDENADO: revisión antes de la aprobación humana)

```
analyze → develop → propose → review
   review error                      → failTask (sin fallback)
   review rechazado + quedan intentos → develop (corrige con hallazgos)
   review rechazado + sin cupo        → failTask (RECHAZO DEFINITIVO)
   review aprobado → approvalTask [aprobación humana]
                       approve → applyTask → finishTask
                       reject  → failTask (repo intacto)
```

- Una revisión rechazada devuelve los `findings` a `develop`, que genera una
  propuesta nueva. El contenido corregido difiere → **hash nuevo** → exige
  **nueva aprobación humana**.
- Límite explícito de correcciones (`MAX_CORRECTIONS`); al agotarlo, rechazo
  definitivo. Sin bucles infinitos (el contador `attempts` corta).
- Al generar una nueva propuesta, `develop` resetea `reviewDecision`,
  `reviewFindings`, `approvalPhase` y `appliedHash`.

## Seguridad y persistencia conservadas (Fases 5-7)

- Claude sigue sin permisos de escritura; genera sólo propuestas.
- La aprobación humana precede a la aplicación; la aplicación va atada al hash.
- Propuestas rechazadas (por revisión o por el humano) no tocan el repo.
- Checkpointer SQLite, reanudación con el mismo `thread_id`, idempotencia y
  rollback best-effort de la Fase 7 siguen vigentes.

## Pruebas (56 en total)

- `src/review/mock-reviewer.test.ts`: aprueba/rechaza/corrige/error +
  `coerceReviewResult` (inválido ≠ aprobación).
- `src/graph.test.ts` (Fase 8): los 5 casos del flujo (aprobado, rechazado con
  hallazgos, corregido-aprobado con hash nuevo, rechazo persistente→definitivo,
  error de revisión) + seguridad (rechazada no modifica repo, rechazo humano
  intacto, fallos de analyze/develop, sin bucle infinito) + persistencia.
- Deterministas, en dir temporal, sin SSO ni llamadas reales; no tocan el repo.

## Limitaciones

- El revisor es un mock determinista; no evalúa el contenido real de la
  propuesta (lo decide por reglas de intento, no por análisis).
- `analyze`=Kiro real, `develop`=Claude real, `review`=simulado. Sin Codex,
  Godot, WebSocket ni UI.
