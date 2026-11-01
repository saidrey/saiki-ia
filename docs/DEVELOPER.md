# Fase 11 — Desarrollador Claude (propuesta, sin aplicar)

Tras una HU aprobada y su análisis técnico, Saiki-IA clasifica la viabilidad y,
si procede, Claude genera una **propuesta de implementación** estructurada,
trazable y segura. Claude NO escribe en el repositorio. El flujo se detiene en la
aprobación humana; en esta fase NO se aplican cambios.

## Flujo (en `src/hu/hu-graph.ts`, extiende Fases 9-10)

```
generateHu → approval(HU) → technicalAnalysis → classify
   classify = blocked          → END (Claude NO se ejecuta; motivos disponibles)
   classify = partially_ready  → partialDecision [interrupt]
                                   proceed → develop ; cancel → blocked(END)
   classify = ready            → develop
develop (Claude, propuesta)    → dev_proposed → devApproval [interrupt]
   approve → dev_approved (TERMINAL, sin aplicar)
   reject  → dev_rejected
   fallo/invalido → dev_failed
```

## Clasificación de viabilidad (`src/dev/feasibility.ts`)

Derivada del CONTENIDO del análisis técnico (no arbitraria):
- `blocked`: el análisis no propone cambios implementables.
- `partially_ready`: hay cambios, pero también preguntas pendientes o rutas no
  verificables → requiere decisión humana.
- `ready`: hay cambios, sin preguntas bloqueantes ni rutas no verificables.

Un análisis exitoso NO equivale a HU lista: la clasificación decide.

## Contrato de ENTRADA (`DevContext`)

Se arma DESDE el estado (fuente única; Claude no reconstruye): versión de la HU,
resumen, necesidad, tareas, criterios, supuestos y preguntas; análisis técnico
(flujo actual, archivos afectados verificados, cambios sugeridos, dependencias,
riesgos, preguntas); viabilidad y motivos; y restricciones arquitectónicas.

## Contrato de SALIDA (`DevProposal`, validado)

summary, technicalDecisions, changes[{path, operation create/modify/delete,
content}], traceability, risks, dependencies, openQuestions, coveredCriteria,
uncoveredCriteria. El validador diferencia archivos **nuevos / existentes / no
verificables** (verificación en disco; rechaza absolutas/traversal). No exige que
haya cambios (una propuesta puede explicar por qué no propone, sin presentarse
como lista para aplicar).

## Seguridad: Claude no escribe (verificado empíricamente)

- Reutiliza `ClaudeCliAdapter` en **solo lectura** (desde la validación E2E de
  Project Context): `-p --tools Read,Glob,Grep --allowedTools Read Glob Grep --permission-mode dontAsk --restricted --strict-mcp-config --disallowedTools Write Edit NotebookEdit Bash WebFetch WebSearch`.
  Claude lee los archivos del proyecto (confinado al directorio de trabajo) antes
  de proponer; no puede escribir, ejecutar comandos ni usar la red. `rawPrompt`
  solo cambia el prompt (JSON), no debilita permisos.
- La huella del repo se verifica antes/después: **INTACTA**. Confirmado en la
  integración real (ver abajo).

## Aprobación atada al hash

Se calcula `hashDevProposal` (SHA-256 canónico). La aprobación corresponde al
contenido exacto. Si la propuesta cambia, el hash cambia → nueva aprobación.
En esta fase NO se aplican cambios (se reutilizará el aplicador seguro existente
en una fase posterior, sin debilitarlo).

## Persistencia

Referencia/versión de HU, análisis técnico, viabilidad, propuesta, hash y estado
de aprobación se persisten (checkpointer SQLite). Tras reinicio, el estado se
recupera con el mismo `thread_id` sin re-ejecutar agentes ni duplicar propuestas.

## Pruebas (105 en total)

`src/dev/feasibility.test.ts` (clasificación) y `src/dev/dev-flow.test.ts` (14
casos: HU rechazada/no aprobada no llega a dev; tech_failed no ejecuta Claude;
blocked no ejecuta; partially_ready exige decisión; ready genera propuesta;
propuesta válida llega a aprobación; inválida no aprobable; error explícito;
repo intacto; persistencia; hash cambia con la propuesta; rutas inseguras). Más
toda la suite anterior. Deterministas, con mocks, sin SSO.

## Integración manual real (opt-in)

`npm run manual:tech` (alias `npm run manual:dev`) ejecuta el flujo completo con
**Kiro + Claude reales**: muestra HU, análisis técnico, viabilidad, propuesta de
Claude y hash; pide decisiones; verifica que el repo queda intacto; registra
evidencia en un `.log` temporal (sin secretos). Requiere `kiro-cli login` y
`claude` autenticado.

**Resultado real observado:** para la HU "clamp(n,min,max) en src/utils/", el
flujo clasificó `partially_ready` (rutas nuevas no existen aún), tras `proceed`
Claude propuso 2 archivos nuevos con decisiones razonadas, trazabilidad por
criterio, y SIN afirmar que ejecutó pruebas. Repo INTACTO. `dev_approved` sin
aplicar.

> Una ejecución exitosa NO garantiza la calidad de la propuesta: eso lo juzga el
> humano al revisar el informe.

## Fuera de alcance (Fase 11)

Aplicación automática de la propuesta, revisor funcional/calidad, moderador, UI,
agentes especializados, skills/reglas de empresa, nuevos proveedores de IA.
