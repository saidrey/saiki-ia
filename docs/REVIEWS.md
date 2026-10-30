# Fase 12 — Revisiones automáticas: funcional y calidad

Dos revisores INDEPENDIENTES (ambos Kiro, solo lectura) evalúan la propuesta de
Claude antes de la aprobación humana final. Ninguna propuesta llega a la
aprobación humana sin pasar por ambas revisiones sobre la MISMA versión.

## Agentes (en `src/reviewers/`)

- **`functionalReviewer`**: ¿la propuesta cumple la HU y sus criterios de
  aceptación? Salida: decision, criterios evaluados/cumplidos/incumplidos,
  hallazgos, cambios requeridos, preguntas, resumen.
- **`qualityReviewer`**: ¿calidad técnica (Clean Code, SOLID aplicable,
  cohesión/acoplamiento, errores, seguridad, regresiones, KISS/YAGNI)? Salida:
  decision, evaluación por categoría, hallazgos con severidad, cambios
  requeridos, riesgos aceptados, resumen.

Son independientes: ninguno sustituye al otro. Instrucciones separadas. Genéricos
(sin reglas de empresa/framework). Solo lectura (`--trust-tools=fs_read`); no
modifican la propuesta ni el repo. Un resultado inválido o un fallo de ejecución
NUNCA se interpreta como aprobación.

## Flujo (en `src/hu/hu-graph.ts`)

```
develop (Claude) → functionalReview
   rechazado + quedan ciclos → develop (corrige con hallazgos)
   rechazado + sin ciclos    → reviewsExhausted (NO aprueba)
   fallo                      → review_failed
   aprobado → qualityReview
      rechazado + quedan ciclos → develop → RE-REVISA AMBAS
      rechazado + sin ciclos    → reviewsExhausted
      fallo                      → review_failed
      aprobado → bothReviews (verifica mismo hash) → reviews_passed → aprobación humana
```

## Invariante clave (decisión del PO)

Las dos revisiones deben aprobar **exactamente la misma versión**. Se guarda
`functionalApprovedHash` y `qualityApprovedHash`. La aprobación humana solo
procede si `functionalApprovedHash === qualityApprovedHash === devProposalHash`.

Cuando Claude corrige, genera una propuesta con **hash nuevo**; el nodo develop
**vacía ambos hashes de aprobación**, de modo que las aprobaciones previas
quedan invalidadas y el flujo re-revisa desde funcional. Así nunca se aprueba
una versión funcional y se termina aplicando otra.

## Límite y agotamiento

`MAX_REVIEW_CYCLES = 3` (global, cada rechazo cuenta un ciclo). Al agotarlo:
`reviews_exhausted` — se detiene, se conservan todos los hallazgos e historial,
y NO se aprueba automáticamente. La decisión (modificar HU, etc.) queda al humano.

## Persistencia

Se persisten `functionalReview`, `qualityReview`, los hashes de aprobación,
`reviewCycles` y `reviewHistory` (auditable). Recuperables tras reinicio con el
mismo `thread_id` (checkpointer SQLite).

## Seguridad

Revisores solo lectura; no modifican archivos ni la propuesta ni aprueban la
aplicación. Claude sigue sin escribir. El mecanismo de aprobación humana y la
aplicación segura NO se tocaron. En esta fase NO se aplican cambios.

## Pruebas (123 en total)

`src/reviewers/reviewer-schemas.test.ts` (validadores: inválido != aprobación) y
`src/reviewers/review-flow.test.ts` (17 escenarios: func revisa, calidad solo
tras func, rechazo→corrección→re-revisión, calidad rechaza→re-revisa ambas,
aprobación al hash exacto, agotar ciclos no aprueba, errores explícitos,
persistencia, repo intacto). Deterministas, con mocks, sin SSO.

## Integración manual real (opt-in)

`npm run manual:tech` (alias `manual:dev`, `manual:review`) ejecuta el flujo
completo con Kiro + Claude reales: HU, análisis técnico, viabilidad, propuesta de
Claude, revisión funcional, revisión de calidad, hallazgos, correcciones y
aprobación humana final. Verifica que el repo queda intacto. Requiere
`kiro-cli login` y `claude` autenticado.

> Pendiente de validación humana: la corrida real completa (varios minutos, con
> posibles ciclos de corrección) la ejecuta el usuario. Los agentes subyacentes
> (Kiro para análisis/revisión, Claude para develop) ya se validaron en fases
> 10-11. Una ejecución exitosa NO garantiza la calidad de las revisiones.

## Fuera de alcance

Aplicación de propuestas al repositorio (siguiente fase), moderador, UI, perfiles
especializados, skills de empresa, nuevos proveedores de IA.
