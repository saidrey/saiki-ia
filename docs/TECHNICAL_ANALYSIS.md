# Fase 10 — Analista técnico genérico (technicalAnalyst)

Tras aprobar una HU, un analista técnico estudia el código existente (solo
lectura) y produce un análisis estructurado de QUÉ cambiar y DÓNDE. No modifica
código. Es la entrada del agente desarrollador en una fase futura.

## Rol `technicalAnalyst`

- Reutiliza `KiroCliAdapter` con **solo lectura**: `--trust-tools=fs_read`.
  Verificado contra `kiro-cli chat --help` (v2.35.2): el ejemplo oficial usa
  `--trust-tools=fs_read,fs_write`; usamos SOLO `fs_read`. Nunca escritura ni
  ejecución arbitraria.
- Instrucciones SEPARADAS del grafo y de las de HU (`src/tech/tech-instructions.ts`),
  para poder especializarlas en el futuro.
- Genérico: sin skills ni directrices de empresa.

## Esquema validado (`src/tech/tech-schema.ts`)

`TechnicalAnalysis`:
- `summary`, `currentFlow`.
- `affectedFiles[{ path, responsibility, exists? }]`.
- `proposedChanges[{ path, change }]` (descriptivo, NO aplicable).
- `traceability[{ ref, note }]` (relación con tareas/criterios de la HU).
- `dependencies[]`, `risks[]`, `openQuestions[]`.

**Verificación de rutas (requisito del PO):** `validateTechnicalAnalysis` abre el
disco y comprueba cada `affectedFiles[].path`:
- Marca `exists: true/false`.
- Las rutas que no existen se devuelven en `unresolvedPaths` (se reportan, no se
  dan por buenas en silencio).
- Rechaza rutas absolutas o con `..` como "no verificables".
El agente puede proponer archivos nuevos, pero lo no verificable queda señalado.

## Integración con el flujo de HU

```
... approvalTask (HU) 
      - approve           -> technicalAnalysisTask -> END (phase="tech_analyzed")
      - reject / revision_limit -> END   (NO llega al análisis)
      - revise            -> generateHuTask
technicalAnalysisTask:
      - éxito  -> phase "tech_analyzed" (+ technicalAnalysis + unresolvedPaths)
      - fallo/inválido -> phase "tech_failed" (+ error)   [ruta explícita, sin fallback]
```

- Una HU **rechazada** o que agotó revisiones NO llega al análisis técnico.
- El análisis técnico es **terminal** en esta fase: el grafo se detiene con el
  resultado disponible. No se conecta `develop` ni las revisiones todavía.
- El resultado se guarda en el estado persistido (SQLite) y se recupera tras
  reinicio con el mismo `thread_id`.

## Estado añadido (`src/hu/hu-state.ts`)

`technicalAnalysis` (TechnicalAnalysis | null), `unresolvedPaths` (string[]),
y las fases `tech_analyzed` / `tech_failed`.

## Seguridad

- Solo lectura (`fs_read`); nunca escritura ni ejecución.
- No implementa cambios ni produce una propuesta aplicable (eso es del
  aplicador seguro del pipeline develop, que NO se tocó).
- La aprobación de la HU no es autorización para escribir archivos.

## Pruebas (83 en total)

- `src/tech/tech-schema.test.ts`: validador — ruta existente/inexistente/
  absoluta/traversal, análisis incompleto, no-objeto.
- `src/tech/tech-flow.test.ts` (7 casos): corre tras aprobar (`tech_analyzed`),
  NO corre si se rechaza, `exists=true` sin unresolved, ruta inexistente en
  `unresolvedPaths`, inválido→`tech_failed`, fallo del agente→`tech_failed`,
  persistencia/recuperación tras reinicio.
- Deterministas, sin SSO ni llamadas reales; no tocan el repo.

## Limitaciones pendientes

- `technicalAnalyst` es Kiro genérico, sin especializar (a propósito).
- La verificación de rutas confirma EXISTENCIA, no que el análisis del flujo sea
  correcto (eso depende del modelo real; en tests se usa mock).
- No conectado a `develop`/`functionalReview`/`qualityReview`/orchestrator.
- Integración real con Kiro para el análisis técnico: opt-in, sin script manual
  todavía (los tests usan mock).
