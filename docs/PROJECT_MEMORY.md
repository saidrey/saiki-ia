# saiki-ia — Memoria del proyecto

> Documento de referencia para retomar el proyecto desde cualquier sesión, modelo
> de IA o persona. Si llegas aquí sin contexto previo, **lee este archivo primero**.
>
> **Nombre oficial: `saiki-ia`.**
> Última actualización: 2026-10-30 · Última fase completada: **Project Registry** (§3.23)

---

## 1. Visión del proyecto

**saiki-ia** es un orquestador personal de agentes de IA construido con
**LangGraph.js + TypeScript**. La meta a largo plazo:

- Coordinar agentes reales (Kiro CLI, Claude Code, Codex).
- Aprobaciones humanas (human-in-the-loop).
- Memoria de aprendizajes.
- Una interfaz tipo videojuego en **Godot**.

**Principios rectores**: KISS y evitar sobreingeniería. Se avanza por fases y
**no se pasa a la siguiente fase sin confirmación explícita del dueño del proyecto.**

---

## 2. Estado de las fases

| Fase | Descripción                                             | Estado        |
| ---- | ------------------------------------------------------- | ------------- |
| 1    | Fundamentos de LangGraph: grafo secuencial simulado     | ✅ Completada |
| 2    | Rutas condicionales: bucle de corrección con límite     | ✅ Completada |
| 3    | Arquitectura de agentes: contrato `AgentAdapter` (mock)  | ✅ Completada |
| 4    | Integración real de Kiro CLI en el rol `analyze`         | ✅ Completada |
| 5    | Integración de Claude Code en `develop` (modo propuesta) | ✅ Completada |
| 6    | Human-in-the-loop: aprobación antes de aplicar cambios   | ✅ Completada |
| 7    | Persistencia durable (SQLite) + idempotencia + rollback  | ✅ Completada |
| 8    | Revisión estructurada simulada + ciclo de corrección     | ✅ Completada |
| 9    | Flujo de HU (huAnalyst) con aprobación humana            | ✅ Completada |
| 10   | Analista técnico genérico (technicalAnalyst, solo lectura)| ✅ Completada |
| 11   | Desarrollador Claude (propuesta + viabilidad, sin aplicar)| ✅ Completada |
| 12   | Revisiones automáticas funcional + calidad (Kiro)        | ✅ Completada |
| 13   | Aprobación humana final y aplicación segura              | ✅ Completada |
| 14   | Arquitectura: moderador, KB compartida, multiagente      | ✅ Completada |
| 15   | Integración extremo a extremo (`SaikiCore`)              | ✅ Completada |
| 16   | Moderador conversacional con LLM                         | ✅ Completada |
| 17   | Síntesis de asistencia integrada en el Core              | ✅ Completada |
| 18   | Auditoría del backend y diseño de API (solo diagnóstico) | ✅ Completada |
| 19   | API REST local                                           | ✅ Completada |
| 20   | Bus de eventos y SSE                                     | ✅ Completada |
| 21b  | Puertas HU / viabilidad parcial por HTTP (backend)       | ✅ Completada (ver §3.20) |
| 21   | Jev (frontend, `web/`)                                   | ✅ Completada (ver §3.21) |
| 21e  | Estabilización del backend (hallazgos 0, 13, 14, 15)     | ✅ Completada (ver §3.22) |
| 22   | Project Registry (varios repositorios locales aislados)   | ✅ Completada (ver §3.23) |

> La tabla se puso al día el 2026-10-30. Las filas 13–20 se completaron a partir
> de las secciones §3.12–§3.19 de este archivo, que ya las daban por completadas.

### Roadmap tentativo (NO implementar sin confirmación)

- Aplicar la propuesta aprobada (reutilizar el aplicador seguro transaccional;
  enlazar aprobación humana + aplicación con rollback). Es la siguiente fase.
- Roles aún conceptuales: finalApproval dedicado, orchestrator.
- Sustituir el revisor simulado por uno real (el contrato `Reviewer` ya lo permite).
- Rollback verdaderamente atómico (staging + move) — hoy es best-effort.
- Interfaz de usuario (captura del click de aprobación).
- Memoria de aprendizajes (posiblemente Engram; ver nota en §6).
- Interfaz en Godot.

---

## 3. Fase 1 — Qué se construyó (COMPLETADA)

### Objetivo
Aprender y validar los fundamentos de LangGraph con un grafo secuencial que
**simula** un flujo de desarrollo de software. Sin IA real, sin API keys.

### Flujo del grafo
```
START → analyzeTask → developTask → reviewTask → END
```
1. `analyzeTask` — lee `task`, genera `plan`.
2. `developTask` — lee `plan`, genera `implementation`.
3. `reviewTask` — lee `implementation`, genera `review`.

### Estado compartido (`src/state.ts`)
Definido con `Annotation.Root`. Cuatro canales, cada uno "last write wins":

| Campo            | Lo escribe    | Contenido                          |
| ---------------- | ------------- | ---------------------------------- |
| `task`           | invocador     | tarea de entrada (string)          |
| `plan`           | `analyzeTask` | plan simulado                      |
| `implementation` | `developTask` | implementación simulada            |
| `review`         | `reviewTask`  | veredicto simulado ("APROBADO...") |

**Regla clave aprendida**: cada nodo recibe el estado completo (lectura) pero
devuelve SOLO el delta (las claves que cambia). LangGraph fusiona los deltas.

### Archivos
```
.
├── package.json         # deps pineadas + scripts
├── tsconfig.json        # TS estricto, ESM, moduleResolution "Bundler"
├── vitest.config.ts     # tests
├── .npmrc               # registry público (ver §6)
├── .gitignore
├── README.md            # instrucciones de uso
├── docs/
│   └── PROJECT_MEMORY.md # este archivo
└── src/
    ├── state.ts         # estado tipado (Annotation.Root) + reducers + MAX_CORRECTIONS
    ├── nodes.ts         # analyze, develop, review, finish, fail
    ├── graph.ts         # StateGraph + addConditionalEdges + compile()
    ├── index.ts         # invoke() del grafo (3 escenarios)
    └── graph.test.ts    # 5 pruebas (Fase 1 + aprobación/corrección/fallo)
```

> Nota: el árbol de archivos de arriba refleja el estado tras la Fase 2.
> La descripción por archivo de la Fase 1 era más simple (3 nodos, 2 tests).

### Cómo se verificó (criterios de aceptación, todos ✅)
- El proyecto se ejecuta sin errores → `npm start` sale con exit code 0.
- Los 3 nodos corren en orden → trazas `[inicio]/[fin]` analyze→develop→review.
- `analyze` llega a `develop` → el `plan` aparece dentro de `implementation`.
- `develop` llega a `review` → `review` dice "APROBADO" (solo si hubo implementación).
- Prueba automatizada pasa → `vitest run` → 2 passed.
- El test de encadenamiento usa `result.implementation.endsWith(result.plan)`.

---

## 3.1. Fase 2 — Rutas condicionales (COMPLETADA)

### Objetivo
Introducir enrutamiento condicional: tras `reviewTask`, decidir si el flujo
termina (aprobado), vuelve a `developTask` para corregir, o termina en fallo al
agotar el límite de correcciones. Todo sigue simulado (sin IA/CLI/BD/HITL).

### Flujo del grafo
```
START → analyzeTask → developTask → reviewTask → (condicional)
   ├─ aprobado             → finishTask → END   (status = "approved")
   ├─ rechazado + quedan    → developTask        (bucle de corrección)
   └─ rechazado + sin cupo  → failTask   → END   (status = "failed")
```

### Cambios en el estado (`src/state.ts`)
Campos nuevos añadidos a `WorkflowState`:

| Campo       | Tipo                            | Rol                                        |
| ----------- | ------------------------------- | ------------------------------------------ |
| `approved`  | boolean                         | veredicto booleano; lo lee la arista cond. |
| `attempts`  | number (REDUCER acumulador)     | cuenta desarrollos; `reducer: cur + delta` |
| `status`    | "approved" \| "failed" \| ""    | resultado final explícito                  |
| `failUntil` | number                          | control de SIMULACIÓN (ver abajo)          |

Además: constante `MAX_CORRECTIONS = 2` exportada desde `state.ts`.

**Concepto clave — reducer:** `attempts` usa
`reducer: (current, delta) => current + delta` para ACUMULAR en vez de pisar.
Así `develop` devuelve `{ attempts: 1 }` en cada pasada y el total crece
(1, 2, 3...). Sin reducer no se podrían contar reintentos. Los demás campos
nuevos usan reducer de reemplazo (último valor gana).

**`failUntil` NO es lógica de negocio**, es un truco de simulación determinista:
`review` aprueba cuando `attempts > failUntil`. Permite forzar escenarios sin
aleatoriedad: `0` aprueba ya; `1` aprueba al 2º intento; `99` nunca aprueba.

### Cambios en nodos (`src/nodes.ts`)
- `develop`: ahora devuelve `{ implementation, attempts: 1 }` (incrementa).
- `review`: devuelve `{ review, approved }`; aprueba si `attempts > failUntil`.
- `finish` (nuevo): nodo terminal de éxito, fija `status: "approved"`.
- `fail` (nuevo): nodo terminal de fallo, fija `status: "failed"`.

### La arista condicional (`src/graph.ts`)
Reemplaza la arista fija `reviewTask → END` de la Fase 1:
```ts
.addConditionalEdges("reviewTask", routeAfterReview, {
  developTask: "developTask",
  finishTask: "finishTask",
  failTask: "failTask",
})
```
`routeAfterReview(state)` LEE el estado y devuelve el nombre del siguiente nodo
(no modifica estado). Lógica: si `approved` → finish; si quedan correcciones
(`attempts - 1 < MAX_CORRECTIONS`) → vuelve a develop; si no → fail.

**Cómo se evita el bucle infinito:** `attempts` crece de verdad (reducer) y se
compara contra `MAX_CORRECTIONS` fijo; la rama de "sin cupo" va obligatoriamente
a `failTask → END`. No se depende del `recursionLimit` de LangGraph (red de
seguridad, no diseño).

### Criterios de aceptación (los 3 escenarios, todos ✅)
Verificados en `npm start` (3 escenarios visibles) y en 5 tests (`npm test`):
- **Aprobación inmediata**: `failUntil:0` → `finish`, `status:approved`, `attempts:1`.
- **Rechazo + corrección + aprobación**: `failUntil:1` → develop/review x2 →
  `finish`, `status:approved`, `attempts:2`. (Demuestra el regreso a revisión.)
- **Fallo persistente**: `failUntil:99` → develop/review x3 → `fail`,
  `status:failed`, `attempts: 1 + MAX_CORRECTIONS`.

**Lección de testing:** una traza que "se ve parecida" (repeticiones develop/
review) NO equivale a cubrir un caso. El caso "rechaza → corrige → APRUEBA" es
distinto del "falla siempre" y necesita su propio test. Separar escenarios por
su resultado final (aprueba vs falla) da cobertura real.

### Archivos tocados en Fase 2
`src/state.ts` (campos + reducer + MAX_CORRECTIONS), `src/nodes.ts`
(develop/review + finish/fail), `src/graph.ts` (addConditionalEdges +
routeAfterReview), `src/index.ts` (3 escenarios), `src/graph.test.ts` (5 tests).

---

## 3.2. Fase 3 — Arquitectura de agentes (COMPLETADA)

### Objetivo
Preparar la arquitectura para integrar agentes reales (Kiro CLI, Claude Code,
Codex) SIN conectarlos todavía. Se define un contrato y los nodos pasan a
depender de esa abstracción, no de agentes concretos. Todo sigue simulado.

### El patrón: adapter + inversión de dependencias
```
ANTES (Fase 2):  nodo ──► lógica simulada incrustada en el nodo
AHORA (Fase 3):  nodo ──► AgentAdapter (contrato) ◄── MockAgentAdapter
                                                   ◄── (futuro) ClaudeAdapter...
```
Los nodos dependen de la abstracción. Conectar un agente real = crear una clase
que implemente `AgentAdapter`; NO se tocan los nodos ni el grafo.

### Contrato (`src/agents/types.ts`)
- `AgentRole` = `"analyze" | "develop" | "review"` (roles iniciales).
- `AgentStatus` = `"success" | "failure"`.
- `AgentRequest` = `{ role, input, context? }`.
- `AgentResult` = `{ status, output, error?, role }` (campos mínimos exigidos:
  status, output, error).
- `AgentAdapter` = `{ name, run(request): Promise<AgentResult> }`.
- Regla de comportamiento: un fallo se reporta como `status: "failure"` + `error`,
  NUNCA lanzando excepción. Así el nodo siempre recibe un `AgentResult`.
- `run` es async desde ya (los agentes reales serán lentos: CLI/modelo).

### Adaptador simulado (`src/agents/mock-agent.ts`)
`MockAgentAdapter implements AgentAdapter`. No ejecuta procesos externos ni
llama modelos; es determinista. Opción `failRoles: AgentRole[]` para forzar
fallos por rol de forma determinista (mismo criterio que `failUntil`).

### Conexión nodos ↔ adaptador (`src/nodes.ts`, `src/graph.ts`)
- Los nodos pasaron a ser FÁBRICAS: `makeAnalyze(agent)`, `makeDevelop(agent)`,
  `makeReview(agent)` reciben el adaptador y devuelven la función-nodo. Es
  inyección de dependencias sin variables globales.
- `finish` y `fail` NO usan agente (cierres deterministas del grafo).
- `buildGraph(agent = new MockAgentAdapter())`: el adaptador se inyecta; por
  defecto es el mock. Un futuro adaptador real se pasa por aquí.
- La DECISIÓN de aprobar sigue siendo del grafo (vía `failUntil`), no del
  agente. Así el flujo condicional de la Fase 2 queda intacto.

### Cómo se conectará un adaptador real (futuro, NO implementar aún)
1. Crear p. ej. `src/agents/claude-agent.ts` con
   `class ClaudeAdapter implements AgentAdapter`.
2. Dentro de `run`, lanzar el CLI / llamar al modelo y mapear su salida a
   `AgentResult` (capturar errores → `status: "failure"`).
3. Pasarlo a `buildGraph(new ClaudeAdapter(...))`. Nodos y grafo NO cambian.
4. OJO (fase posterior): antes de ejecutar acciones sensibles del agente real,
   habrá que interponer el sistema de permisos/aprobaciones (HITL) que BLOQUEE
   la acción antes de ejecutarla.

### Verificación (todos ✅)
- `npm start`: los 3 escenarios de la Fase 2 se mantienen idénticos en
  comportamiento (approved/1, approved/2, failed/3); ahora el texto de salida
  proviene del adaptador.
- `npm test`: 11 tests en 2 archivos (5 del grafo Fases 1-2 + 6 del adaptador,
  cubriendo resultado exitoso y fallido).

### Archivos de la Fase 3
Nuevos: `src/agents/types.ts`, `src/agents/mock-agent.ts`,
`src/agents/mock-agent.test.ts`. Modificados: `src/nodes.ts` (fábricas +
delegación), `src/graph.ts` (inyección del adaptador), `src/index.ts` (título).

### Renombrado del proyecto (hecho en esta fase)
El proyecto adoptó su nombre oficial **`saiki-ia`** (reemplazando un nombre
provisional anterior). Tocados: `package.json` (name + description),
`package-lock.json` (regenerado con `npm install --package-lock-only`),
`README.md`, `src/index.ts` (log), este documento y el steering. El
funcionamiento y los tests no cambiaron.

---

## 3.3. Fase 4 — Integración real de Kiro CLI (COMPLETADA)

### Objetivo
Conectar el rol `analyze` con **Kiro CLI real** (`kiro-cli chat
--no-interactive`), manteniendo `develop` y `review` simulados. Validar que un
agente real se integra con el estado y las rutas condicionales de LangGraph.

### Decisión de agente (por qué Kiro CLI)
- Kiro IDE (el asistente del editor) NO es invocable como subproceso: es un
  entorno interactivo, no una herramienta transaccional. Descartado.
- **Kiro CLI** sí es una CLI headless real (sucesora del Amazon Q Developer CLI),
  invocable como `kiro-cli chat --no-interactive "<prompt>"`. Aprovecha el plan
  SSO que ya paga el dueño. Elegida.
- Claude Code también sirve, pero consumiría cuota aparte. Codex no instalado.

### Autenticación (importante para retomar)
- Se usa **login SSO interactivo**: `kiro-cli login` (abre navegador, guarda
  sesión local). El código NO inicia sesión ni guarda credenciales; reutiliza
  la sesión del entorno.
- La vía **API key headless (`KIRO_API_KEY`) NO está disponible**: la
  organización SSO corporativa tiene deshabilitada la gestión de API keys
  ("API key management is disabled for your organization. Contact your
  administrator"). Para habilitarla haría falta un admin de la org. NO reintentar
  ese camino sin que el dueño confirme que ya está habilitado.
- Datos SSO del entorno (de `~/.aws/sso/cache`): Start URL
  corporativa (no se versiona), Region `us-east-1`.
- La sesión SSO expira; si la integración real falla por auth, correr de nuevo
  `kiro-cli login`.

### Arquitectura añadida
- `src/agents/process-runner.ts` — `ProcessRunner` (abstracción inyectable) y
  `spawnProcessRunner` (real, con `spawn` SIN shell + args como array para
  evitar inyección; timeout; tope de bytes de salida; NUNCA lanza).
- `src/agents/kiro-cli-agent.ts` — `KiroCliAdapter implements AgentAdapter`.
  Invoca `kiro-cli chat --no-interactive --trust-tools=read "<prompt>"`. Mapea:
  startError / timeout / exit≠0 / stdout vacío → `status:"failure"` + `error`;
  éxito → `status:"success"`. Timeout (60s) y maxOutputBytes (1 MiB)
  configurables. El `runner` se inyecta (tests usan uno falso).
- `src/agents/router.ts` — `AgentRouter` / `MapAgentRouter` /
  `createDefaultRouter`. Reparto por rol: analyze→Kiro real, develop/review→mock.
  Único lugar que sabe "quién ejecuta qué". Acepta overrides para tests.

### Integración con el grafo (fallo explícito)
- Los nodos ahora reciben un `AgentRouter` y piden el adaptador de su rol.
- Estado ampliado: `analyzeFailed` (bool) y `analyzeError` (string).
- `graph.ts`: NUEVA arista condicional `routeAfterAnalyze`. Si `analyzeFailed`,
  va directo a `failTask` SIN ejecutar `develop`. El nodo `fail` deja el detalle
  del error en `review` ("FALLO EN ANALYZE (Kiro CLI): ...").
- Sin fallback al mock: un fallo real es visible y termina en ruta de fallo.

### Estrategia de pruebas (deterministas, sin llamar a Kiro)
- `src/agents/kiro-cli-agent.test.ts`: inyecta un `ProcessRunner` falso. Cubre
  los 4 casos exigidos — éxito, exit≠0, timeout, fallo al iniciar — más stdout
  vacío, truncado y verificación de args.
- `src/graph.test.ts`: helper `mockRouter()` → los tests del grafo usan SOLO
  mock (nunca Kiro real). Nuevo test: fallo de analyze no ejecuta develop y
  termina "failed".
- `npm start` también usa router solo-mock (rápido, determinista, sin créditos).

### Prueba de integración manual (opt-in, Kiro real)
- `src/manual/kiro-integration.ts` + script `npm run manual:kiro`.
- Documentada en `docs/MANUAL_INTEGRATION_TEST.md` (requisitos, cómo correr, qué
  esperar en éxito/fallo, limitaciones).
- Ejecutada con éxito: plan generado por Kiro real, develop/review mock,
  `status: approved`.

### BUG resuelto durante la fase
`plan`, `implementation` y `review` no tenían `default` en el estado. Cuando el
grafo saltaba a `failTask` sin pasar por `develop`, quedaban `undefined` (no
`""`). Añadido `default: () => ""` a los tres canales. Causa raíz, no parche.

### Límite de salida
El runner trunca stdout/stderr al superar `maxOutputBytes` (1 MiB) y marca
`truncated`; el adaptador añade "[salida truncada]" al output. Evita que una
salida descontrolada agote memoria.

### Verificación (todos ✅)
- `npm test`: 19 tests en 3 archivos (grafo Fases 1-2 + fallo analyze, mock
  adapter, kiro-cli adapter). Typecheck limpio.
- `npm run manual:kiro`: integración real end-to-end OK (`status: approved`).

### Restricciones respetadas
Solo `analyze` real; develop/review simulados. Sin HITL/aprobaciones (por eso
`analyze` corre con `--trust-tools=`, sin herramientas). Sin modelos extra, BD,
GUI ni WebSocket.

---

## 3.4. Fase 5 — Integración de Claude Code en `develop` (COMPLETADA)

### Objetivo
Conectar el rol `develop` con **Claude Code real en modo PROPUESTA**: genera
código como texto, SIN aplicar cambios al repo. Flujo: Kiro analiza → Claude
propone → review simulado → corrección si falla. Mantiene analyze (Kiro) real.

### Seguridad de permisos (lo central de la fase)
Requisito del PO: demostrar que Claude propone pero NO modifica el repo, con
permisos (no solo con el prompt). Verificado contra `claude --help` (v2.1.251):

Flags usados por `ClaudeCliAdapter` (`src/agents/claude-cli-agent.ts`):
- `-p` (modo no interactivo).
- `--tools ""` → desactiva TODAS las herramientas built-in (Bash/Write/Edit/...).
- `--restricted` → quita herramientas de ejecución de código.
- `--strict-mcp-config` → ignora MCP servers (podrían escribir).
- `--disallowedTools Write Edit Bash` → denegación explícita (defensa en profundidad).

**Evidencia empírica**: al pedirle crear/modificar archivos, el repo quedó
INTACTO (sin archivos nuevos, MD5 idéntico), incluso cuando el modelo "dijo" que
lo haría. Lo que impide la escritura es el mecanismo de permisos, no el prompt.

### BUG CRÍTICO resuelto (gotcha de la CLI)
`--disallowedTools <tools...>` es **variádico**. Con el prompt como argumento
posicional después de ese flag, Claude interpretaba cada PALABRA del prompt como
un nombre de tool a denegar ("Permission deny rule X matches no known tool") y
no generaba nada. **Solución: pasar el prompt por STDIN**, no como arg. Se añadió
soporte `stdin` al `ProcessRunner`. Lección: verificar el comportamiento real de
los flags (sobre todo los variádicos), no asumirlo.

### Estado y flujo
- Estado ampliado: `developApplied` (SIEMPRE false en esta fase: propuesta ≠
  aplicado), `developFailed`, `developError`.
- `graph.ts`: nueva arista condicional `routeAfterDevelop` → si Claude falla, va
  a `failTask` SIN pasar por review (propagación explícita, sin fallback).
- Nodo `develop` marca la salida con `[PROPUESTA]` y `developApplied: false`.
- Nodo `fail` muestra "FALLO EN DEVELOP (Claude Code): ..." cuando aplica.
- Router por defecto: analyze=Kiro real, develop=Claude real, review=mock.

### Pruebas (deterministas, sin llamar a Claude)
- `src/agents/claude-cli-agent.test.ts`: 6 tests (éxito, exit≠0, timeout,
  startError, stdout vacío, y test de SEGURIDAD que verifica los flags y que el
  prompt va por stdin, NO en los args).
- `src/graph.test.ts` (Fase 5): la propuesta se marca `[PROPUESTA]`;
  `developApplied` siempre false (incluso tras aprobar); fallo de develop no
  ejecuta review y termina "failed".
- `npm test`: 28 tests en 4 archivos. Ninguno llama a Claude/Kiro real.

### Prueba de integración manual (opt-in)
- `src/manual/claude-integration.ts` + `npm run manual:claude`.
- Toma una huella (ruta+tamaño+mtime) de `src/` ANTES y DESPUÉS y falla si algo
  cambió → prueba automática de que el repo queda intacto.
- Doc: `docs/MANUAL_CLAUDE_INTEGRATION.md`.
- Ejecutada OK: Kiro analiza real → Claude propone código real → review mock →
  `approved`, `developApplied: false`, repo INTACTO (16 archivos, 0 cambios).

### BUG secundario resuelto
`approved` no tenía `default` en el estado; al saltar a `failTask` sin pasar por
review quedaba `undefined`. Añadido `default: () => false`.

### Restricciones respetadas
NO se aplican cambios al repo (escritura real + aprobaciones = fase posterior).
Review sigue simulado. Sin Codex, sin Godot, sin BD/GUI/WebSocket.

---

## 3.5. Fase 6 — Human-in-the-loop (COMPLETADA)

Doc detallada: `docs/HUMAN_IN_THE_LOOP.md`.

### Objetivo
Pausar el grafo cuando hay una propuesta y esperar decisión humana
(approve/reject) ANTES de aplicar cambios. Criterio del PO: lo aprobado es
exactamente lo que se aplica; un rechazo nunca toca el repo.

### Flujo
```
analyze → develop → proposeTask (estructura+hash) → approvalTask [interrupt: PAUSA]
  approve → applyTask (aplicación controlada) → review → ...
  reject  → failTask (repo intacto)
```

### Pausa/reanudación (API verificada en v1.5.3)
- `interrupt(payload)` pausa en `approvalTask`. Grafo compilado con checkpointer
  (`MemorySaver` por defecto) para persistir estado durante la pausa.
- `buildGraph({ router, checkpointer, rootDir })` — NUEVA firma (antes recibía
  solo el router). `invoke` requiere `{ configurable: { thread_id } }`.
- Reanudar: `invoke(new Command({ resume: { action } }), { configurable: {
  thread_id } })` con el MISMO thread_id. El estado sobrevive.
- NO se simula con sleep/boolean/re-ejecución.

### Seguridad de la aplicación (lo crítico, `src/apply/`)
- `file-change.ts`: `FileChange {path,operation,content}`, `Proposal`,
  `hashProposal` (SHA-256 canónico). El hash es "lo aprobado".
- `applier.ts`: aplica SOLO si `hashProposal === approvedHash` (propuesta
  modificada tras aprobar → rechazada). Valida rutas, detecta conflictos
  (`expectedBaseHashes`), `create` no pisa existentes, reporta `partial` sin
  declarar éxito falso. NO lanza; NO ejecuta shell del modelo.
- `path-validation.ts`: rechaza absolutas, traversal `../`, symlink escape
  (realpathSync), destinos fuera del root.
- Claude sigue SIN escritura (Fase 5). La escritura la hace el aplicador, código
  nuestro, separado del modelo.

### Estado del ciclo
`approvalPhase`: none→pending→(approved→applied|apply_failed)|rejected. Más:
`proposal`, `proposalHash`, `appliedFiles`, `applyError`. Ausencia de decisión =
sigue pausado (NUNCA se aprueba por timeout/ausencia/error).

### Limitación documentada (parser)
Claude devuelve texto libre, no formato máquina (no se inventa capacidad de la
CLI). Solución: el prompt pide convención `FILE: <ruta>` + bloque de código, y
`src/apply/proposal-parser.ts` (código nuestro, determinista) la estructura. Sin
convención → 0 cambios → fallo seguro ("sin cambios aplicables"), no basura.

### Pruebas (39 en 5 archivos, deterministas, dir temporal, sin SSO)
`graph.test.ts`: pausa, persistencia, mismo thread_id, approve aplica solo lo
autorizado, reject intacto, ausencia no aprueba, no-approve=rechazo.
`apply/applier.test.ts`: hash modificado rechazado, rutas peligrosas (absoluta/
traversal/symlink escape), conflicto concurrente, fallo visible, create no pisa.

### HALLAZGO (comportamiento del bucle con HITL)
Con el paso de aprobación intercalado, el conteo de `attempts` en el peor caso
del bucle de corrección baja (p. ej. de 3 a 2). El corte SIGUE acotado y el
grafo TERMINA (no hay bucle infinito); la aserción del test se ajustó a un rango
en vez de un valor exacto. No es un bug del corte, es efecto del nuevo flujo.

### Riesgos pendientes
MemorySaver no sobrevive a reinicios (resuelto en Fase 7). Sin rollback de
cambios aplicados (best-effort en Fase 7). review sigue simulado.

---

## 3.6. Fase 7 — Persistencia durable y recuperación (COMPLETADA)

Doc detallada: `docs/PERSISTENCE_AND_RECOVERY.md`.

### Objetivo
Sobrevivir a reinicios sin perder aprobaciones pendientes, sin aplicar dos veces
una propuesta, y sin declarar éxito si la aplicación queda incompleta.

### Persistencia (SQLite)
- `@langchain/langgraph-checkpoint-sqlite@1.1.0` (`SqliteSaver`), compat con
  langgraph 1.5.3 (verificado). Reemplaza `MemorySaver`.
- `src/persistence/checkpointer.ts`: `createSqliteCheckpointer(dbPath)` (default
  `.saiki/checkpoints.sqlite`, gitignored) y `createMemoryCheckpointer()` (tests).
- `buildGraph()` usa SQLite por defecto. Verificado empíricamente: una NUEVA
  instancia del grafo con el mismo archivo recupera el estado y reanuda.

### Idempotencia
- Estado: `appliedHash` (hash de la propuesta ya aplicada).
- `applyProposalTransactional` con `alreadyAppliedHash`: si coincide → `noop`,
  no reescribe. Protege contra reintentos/reanudaciones/reinicios.
- Se mantiene el hash SHA-256 (propuesta alterada tras aprobar → `rejected`).

### Rollback best-effort (LIMITACIÓN HONESTA)
El FS no es transaccional; NO se ofrece atomicidad real. `transactional-applier.ts`:
snapshot previo → aplica → si falla, rollback (restaura/elimina) → si el rollback
TAMBIÉN falla, `outcome: "unrecoverable"` con informe explícito (`recoveryReport`),
sin declarar éxito. Outcomes: applied/noop/rolled_back/unrecoverable/rejected.
No se ejecutan comandos del modelo para aplicar/restaurar.

### Estado persistido ausente
Reanudar un `thread_id` inexistente → estado vacío, no reanuda, no inventa
aprobación.

### Pruebas (51 en 7 archivos)
`persistence/recovery.test.ts` (5: recupera tras reinicio, hash sobrevive,
pendiente no auto-aprueba, aplica 1 vez, idempotencia) + `apply/
transactional-applier.test.ts` (8: rollback multi-archivo, unrecoverable+informe,
conflicto, hash/rutas) + fases 1-6.

### BUGS resueltos en esta fase
- `realpathSync(root)` fallaba (ENOENT) cuando el root autorizado no existía aún
  → se resuelve el realpath del ancestro existente más cercano.
- Falso positivo de symlink escape en macOS (`/var` → `/private/var`): se mezclaba
  ruta lógica con realpath físico → ahora ambos lados usan realpath.
- `graph.test.ts` usaba el SQLite real del repo (estado compartido/contaminado)
  → ahora inyecta `createMemoryCheckpointer()` en cada test.

### Riesgos pendientes
Rollback es best-effort, no atómico (el caso irrecuperable se REPORTA, no se
oculta). Atomicidad real requeriría staging+move (fuera de alcance KISS).

---

## 3.7. Fase 8 — Revisión estructurada simulada (COMPLETADA)

Doc detallada: `docs/REVIEW.md`.

### Objetivo
`review` pasa de booleano a revisión estructurada (aprueba/rechaza con
hallazgos) y activa un ciclo de corrección limitado. Revisor SIMULADO (no finge
IA); valida el FLUJO revisión→corrección→aprobación.

### Contrato (`src/review/`)
- `review-types.ts`: `ReviewResult {status, decision, findings[id,severity,
  description], summary, error}`. `status:failure` (revisión falló) ≠
  `decision:rejected` (rechazo legítimo). `coerceReviewResult` → un resultado
  inválido NUNCA es aprobación. Interfaz `Reviewer` aislada del grafo.
- `mock-reviewer.ts`: `MockReviewer` determinista configurable
  (`rejectUntilAttempt`, `failExecution`, `findingsOnReject`). Honesto: reglas
  explícitas, no simula modelo.

### Flujo REORDENADO (review ANTES de la aprobación humana)
```
develop → propose → review
  error                      → failTask (sin fallback)
  rechazado + quedan intentos → develop (corrige con hallazgos)
  rechazado + sin cupo        → failTask (RECHAZO DEFINITIVO)
  aprobado → approvalTask [humano] → approve → apply → finish
                                     reject  → fail (repo intacto)
```
Antes (Fase 6/7) review iba DESPUÉS de apply; ahora va ANTES de la aprobación
humana (lo correcto: el humano sólo aprueba lo ya revisado).

### Ciclo de corrección
- Rechazo → `develop` recibe los `findings` en el prompt. La propuesta corregida
  difiere → HASH NUEVO → exige NUEVA aprobación humana.
- `develop` resetea reviewDecision/findings/approvalPhase/appliedHash por
  propuesta nueva.
- Límite `MAX_CORRECTIONS`; al agotarlo, rechazo definitivo. Sin bucles
  infinitos (corta por `attempts`).

### Estado añadido
`reviewDecision` ("approved"|"rejected"|""), `reviewFindings`, `reviewSummary`,
`reviewFailed`, `reviewError`. (`failUntil` quedó legado, ya no lo usa review.)

### Seguridad/persistencia conservadas
Claude sin escritura; aprobación humana antes de aplicar; aplicación atada al
hash; rechazadas no tocan el repo; checkpointer SQLite + reanudación +
idempotencia + rollback (Fase 7) intactos.

### Pruebas (56 en 8 archivos)
`review/mock-reviewer.test.ts` + `graph.test.ts` (5 casos del flujo + seguridad
+ persistencia). Deterministas, dir temporal, sin SSO, NO tocan el repo.

### Limitación
El revisor no evalúa el contenido real; decide por reglas de intento. Es un mock
para validar el flujo, como pidió el PO.

---

## 3.8. Fase 9 — Flujo de HU (huAnalyst) (COMPLETADA)

Doc detallada: `docs/HU_WORKFLOW.md`.

### Objetivo
Preparar el flujo de trabajo con agentes genéricos. Solo `huAnalyst` + su
aprobación humana. Los demás roles (technicalAnalyst, functionalReview,
qualityReview, finalApproval, orchestrator) quedan CONCEPTUALES, no simulados.

### Qué se implementó (en `src/hu/`, flujo INDEPENDIENTE del pipeline)
- `hu-schema.ts`: `AnalyzedHu` (summary, need, tasks[order,description],
  acceptanceCriteria[id,description], assumptions, openQuestions, dependencies)
  + `validateHu` (distingue válido/inválido, SIN fallback).
- `hu-instructions.ts`: prompts SEPARADOS del grafo (piden JSON). Agente
  GENERICO (sin framework/skills de empresa).
- `hu-analyst.ts`: `analyzeHu`/`reviseHu` — usan rol `huAnalyst` (Kiro CLI),
  parsean JSON, validan. Error EXPLÍCITO si falla/invalido (sin fallback).
- `hu-state.ts`: `HuState` independiente (request, hu, versions[], revisions,
  phase, decisions[], error). `MAX_HU_REVISIONS=2`.
- `hu-graph.ts`: `buildHuGraph({router,checkpointer})`. Flujo
  generateHuTask → approvalTask [interrupt]. approve/reject/revise+feedback;
  revise regenera con feedback si hay cupo, si no `revision_limit`. Ausencia NO
  aprueba. Reutiliza checkpointer SQLite + interrupt/resume mismo thread_id.

### Cambios transversales
- `AgentRole` += `"huAnalyst"` (opcional en `RoleAdapterMap`; el pipeline
  develop/review no lo usa). Mock y router actualizados. Default huAnalyst=Kiro.
- `KiroCliAdapter`: para rol `huAnalyst` pasa el input (prompt) tal cual.

### Distinción clave
La aprobación de una HU NO es la autorización para modificar archivos. Flujos y
aprobaciones separados. Una HU aprobada queda en el estado persistido para el
analista técnico (fase futura).

### Pruebas (71 en 10 archivos)
`hu/hu-graph.test.ts` (8 casos del enunciado) + `hu/hu-schema.test.ts`.
Deterministas, sin SSO, NO tocan el repo.

### Limitaciones
huAnalyst es Kiro genérico (sin especializar). Roles restantes sin implementar.
Flujo de HU no conectado al pipeline. Sin orchestrator.

---

## 3.9. Fase 10 — Analista técnico genérico (COMPLETADA)

Doc detallada: `docs/TECHNICAL_ANALYSIS.md`.

### Objetivo
Tras aprobar una HU, un analista técnico estudia el código (solo lectura) y
produce un análisis estructurado de QUÉ cambiar y DÓNDE, sin modificar código.
Es la entrada del desarrollador (fase futura). Extiende el flujo de HU.

### Qué se implementó (`src/tech/`)
- `tech-schema.ts`: `TechnicalAnalysis` (summary, currentFlow, affectedFiles
  [path, responsibility, exists], proposedChanges, traceability, dependencies,
  risks, openQuestions) + `validateTechnicalAnalysis` que VERIFICA rutas en
  disco (`existsSync`), marca `exists`, devuelve `unresolvedPaths` (rutas no
  existentes/no verificables) en vez de inventar. Rechaza absolutas/traversal.
- `tech-instructions.ts`: prompt separado; pide JSON; exige rutas reales o
  declararlas en openQuestions.
- `tech-analyst.ts`: `analyzeTechnical` — rol technicalAnalyst, parsea JSON,
  valida; error EXPLÍCITO sin fallback.

### Permisos (verificado)
`technicalAnalyst` usa `KiroCliAdapter({ trustTools: "fs_read" })`. El tool
`fs_read` se verificó contra `kiro-cli chat --help` (solo lectura). El adaptador
ahora acepta `trustTools` configurable (default "" para analyze/huAnalyst).

### Integración
Nodo `technicalAnalysisTask` en el grafo de HU: tras `approve` → análisis →
terminal (`tech_analyzed`). HU rechazada / revision_limit NO llega. Fallo o
inválido → `tech_failed` (ruta de error explícita). Resultado persistido en
SQLite, recuperable con el mismo `thread_id`. Estado HU +`technicalAnalysis`
+`unresolvedPaths`.

### Pruebas (83 en 12 archivos)
`tech/tech-schema.test.ts` (validador + rutas) y `tech/tech-flow.test.ts` (7
casos). Ajustados 2 tests de Fase 9 (ahora approve encadena el análisis; router
de esos tests incluye un techStub que falla a propósito). Deterministas, sin
SSO, NO tocan el repo.

### Limitaciones
technicalAnalyst genérico (sin especializar). La verificación confirma
EXISTENCIA de rutas, no la corrección del análisis del flujo (depende del modelo
real; tests con mock). No conectado a develop/review ni orchestrator.

### Validación manual real (añadida tras Fase 10) — `npm run manual:tech`
Prueba opt-in con Kiro REAL del flujo HU + análisis técnico (ver
`docs/MANUAL_TECH_INTEGRATION.md`). Ejecutada con éxito: HU de buena calidad;
el análisis técnico leyó el código real, concluyó correctamente que el repo no
tiene UI (para una HU de UI), NO inventó rutas, y el repo quedó intacto.
HALLAZGO que corrigió un bug de diseño: el esquema exigía ≥1 `affectedFiles`, lo
que convertía una conclusión legítima ("la HU no mapea a archivos de este repo")
en un error falso. Se RELAJÓ: `affectedFiles`/`proposedChanges` pueden estar
vacíos si el análisis explica el porqué en summary/currentFlow. Lección: un
análisis técnico válido puede concluir "no implementable aquí tal cual".

---

## 3.10. Fase 11 — Desarrollador Claude (COMPLETADA)

Doc detallada: `docs/DEVELOPER.md`.

### Objetivo
Tras HU aprobada + análisis técnico, clasificar viabilidad y, si procede, Claude
genera una PROPUESTA de implementación trazable. Claude NO escribe. Se detiene en
aprobación humana; NO se aplican cambios en esta fase.

### Qué se implementó (`src/dev/`, extiende el grafo de HU)
- `feasibility.ts`: `classifyFeasibility` deriva ready/blocked/partially_ready
  del CONTENIDO del análisis (no arbitrario), con motivos auditables.
- `dev-schema.ts`: `DevContext` (entrada, armada desde el estado = fuente única)
  y `DevProposal` (salida). `validateDevProposal` clasifica rutas nuevas/
  existentes/no verificables. `hashDevProposal` (SHA-256 canónico).
- `dev-instructions.ts`: prompt (JSON) con restricciones del proyecto, KISS/YAGNI,
  no inventar, no afirmar pruebas ejecutadas.
- `dev-analyst.ts`: `developProposal` — rol develop (Claude), parsea/valida,
  error explícito sin fallback.

### Integración en el grafo de HU
Nodos: `classifyTask` (viabilidad), `partialDecisionGate` (interrupt para
partially_ready: proceed→develop / cancel→blocked), `makeDevelop` (arma
DevContext, llama Claude, valida, hash; nunca si no habilitado), `devApprovalGate`
(interrupt approve/reject, TERMINAL sin aplicar). Fases nuevas: blocked,
needs_decision, dev_proposed, dev_approved, dev_rejected, dev_failed. `develop`
en el router de HU usa `ClaudeCliAdapter({ rawPrompt: true })`.

### Seguridad verificada
Claude con permisos de solo-propuesta (Fase 5). Integración real ejecutada
(`npm run manual:tech`/`manual:dev`): flujo HU→tech→clasificación→Claude generó
propuesta de 2 archivos nuevos con decisiones razonadas, trazabilidad, sin
afirmar pruebas ejecutadas; repo INTACTO; dev_approved sin aplicar. Exit 0.

### Pruebas (105 en 14 archivos)
`dev/feasibility.test.ts` (5) + `dev/dev-flow.test.ts` (14 casos del enunciado).
Ajustados 3 tests de tech-flow (verifican technicalAnalysis vía getState, no fase
terminal, porque el flujo ahora continúa a dev). Deterministas, mocks, sin SSO.

### Límite clave
En esta fase NO se aplican cambios. `dev_approved` es terminal. Claude no puede
saltarse decisiones humanas. Aplicar la propuesta es fase posterior (reutilizará
el aplicador transaccional seguro existente).

---

## 3.11. Fase 12 — Revisiones automáticas funcional + calidad (COMPLETADA)

Doc detallada: `docs/REVIEWS.md`.

### Objetivo
Dos revisores INDEPENDIENTES (Kiro, solo lectura) evalúan la propuesta de Claude
antes de la aprobación humana. Ninguna propuesta llega a aprobación humana sin
pasar ambas revisiones sobre LA MISMA versión.

### Qué se implementó (`src/reviewers/`)
- `reviewer-schemas.ts`: `FunctionalReview` y `QualityReview` + validadores
  (inválido/fallo != aprobación).
- `reviewer-instructions.ts`: prompts INDEPENDIENTES (cada revisor su
  responsabilidad; no evalúa lo del otro). Solo lectura.
- `reviewers.ts`: `runFunctionalReview`/`runQualityReview` (rol Kiro, parsean/
  validan, error explícito sin fallback).
- Roles `functionalReviewer`/`qualityReviewer` (Kiro fs_read) en AgentRole,
  mock, router.

### Flujo (en el grafo de HU)
develop → functionalReview → (rechazo+cupo: develop / aprobado: qualityReview /
fallo: review_failed / sin cupo: reviews_exhausted). quality → (rechazo+cupo:
develop → RE-REVISA AMBAS / aprobado: bothReviews → reviews_passed → aprobación
humana / fallo/sin cupo). `MAX_REVIEW_CYCLES=3` global.

### Invariante del PO (clave)
Ambas revisiones aprueban el MISMO hash. `functionalApprovedHash` y
`qualityApprovedHash` deben == `devProposalHash` para pasar a aprobación humana.
Cuando Claude corrige → hash nuevo → develop VACÍA ambos hashes → se re-revisa
desde funcional. Nunca se aprueba una versión y se aplica otra.

### Seguridad y persistencia
Revisores solo lectura; no modifican propuesta ni repo; no auto-aprueban. Agotar
ciclos → reviews_exhausted (NO aprueba). Persisten reviews, hashes, reviewCycles,
reviewHistory; recuperables tras reinicio (SQLite). En esta fase NO se aplica.

### Pruebas (123 en archivos)
`reviewers/reviewer-schemas.test.ts` + `reviewers/review-flow.test.ts` (17
escenarios del enunciado). Ajustados tests de Fase 11 (ahora el flujo pasa por
revisiones tras develop; sus mocks incluyen revisores que aprueban).
Deterministas, mocks, sin SSO.

### Manual real (opt-in)
`npm run manual:tech`/`manual:dev`/`manual:review`: flujo completo con Kiro +
Claude reales hasta aprobación humana, muestra ambas revisiones. Pendiente de
corrida humana (larga/costosa); los agentes ya validados en Fases 10-11.

---

## 3.12. Fase 13 — Aprobación humana final y aplicación segura (COMPLETADA)

Doc detallada: `docs/APPLY.md`.

### Objetivo
Etapa FINAL del flujo: presentar la propuesta revisada, pedir aprobación humana
explícita, aplicar EXACTAMENTE la versión aprobada, verificar el resultado y
garantizar recuperación/trazabilidad ante errores. Reutiliza el aplicador seguro
(Fase 7); no se creó un segundo aplicador ni se debilitaron controles.

### Qué se implementó
- `src/apply/transactional-applier.ts`: extendido con operación `delete`
  (snapshot previo + restauración en rollback). Validación: `create` no
  sobrescribe; `update`/`delete` exigen que el archivo exista.
- `src/apply/file-change.ts`: `FileOperation` ahora es `create|update|delete`.
- `src/apply/dev-proposal-bridge.ts`: `applyDevProposal()` — verifica
  `hashDevProposal === approvedDevHash` (paso 0), idempotencia por
  `alreadyAppliedDevHash` (→ noop), convierte `create/modify/delete` →
  `create/update/delete` y delega al aplicador transaccional.
- `src/apply/verify-applied.ts`: verificación posterior (contenido real vs
  propuesta); checks del proyecto opt-in (`runChecks`).
- `src/hu/hu-state.ts`: estados nuevos (ver tabla) + campos `finalApprovedHash`,
  `appliedHash`, `applicationId`, `applyOutcome`, `applyReport`, `appliedFiles`,
  `verification`, `auditRecord` (tipos `ApplyOutcome`, `PostApplyVerification`,
  `ApplicationAudit`).
- `src/hu/hu-graph.ts`: reemplaza el terminal `devApprovalTask` por
  `finalApprovalTask` (interrupt: approve/reject/request_changes) →
  `applyTask` (único punto de escritura) → `verifyTask`. `buildHuGraph` acepta
  `applyDir` (default `rootDir`) y `runChecks`.

### Estados (HuPhase, Fase 13)
`awaiting_final_approval`, `final_approval_rejected`, `ready_to_apply`,
`applying`, `applied`, `applied_with_test_failures`, `rolled_back`,
`unrecoverable`, `apply_blocked`.

### Flujo (en el grafo de HU)
bothReviews → reviews_passed → **finalApprovalTask** (interrupt):
- approve → verifica hashes (func==qual==dev) → ready_to_apply → **applyTask** →
  (applied → **verifyTask** → applied / applied_with_test_failures / unrecoverable
  si el contenido no coincide) / rolled_back / unrecoverable / apply_blocked.
- request_changes → vuelve a developTask (invalida hashes; re-revisa AMBAS).
- reject (o ausencia) → final_approval_rejected (END, repo intacto).

### Garantías y validación del hash
Aprobación atada a `hashDevProposal`. `applyTask` recalcula el hash y lo compara
con `finalApprovedHash` ANTES de escribir; si no coincide → `apply_blocked`. Una
aprobación NUNCA es reutilizable para otra versión (si Claude corrige, el hash
cambia y todas las aprobaciones se invalidan).

### Rollback (honesto)
Best-effort, NO atómico (el FS no lo es). `rolled_back` = revertido con éxito;
`unrecoverable` = falló Y el rollback no se completó (no se finge éxito; informe
explícito). Limitaciones documentadas en `docs/APPLY.md`.

### Idempotencia y recuperación
`appliedHash` + `applicationId` persistidos. Tras reinicio (mismo thread_id,
SQLite) se recupera el estado; si `appliedHash` == hash de la propuesta → `noop`
(no reescribe). Un estado persistido NO garantiza archivos intactos: por eso la
verificación compara el disco real.

### Seguridad de escritura (manual)
`npm run manual:tech` aplica por DEFECTO sobre una COPIA TEMPORAL del repo. Para
el repo REAL exige DOBLE autorización: `SAIKI_APPLY_TO_REAL_REPO=1` + escribir
`APLICAR EN REAL`. Único componente que escribe: el aplicador controlado.

### Pruebas (148 en 19 archivos; +25 de Fase 13)
- `apply/dev-proposal-bridge.test.ts` (11): hash, rutas, symlink, concurrencia,
  create/modify/delete, rollback, unrecoverable, idempotencia, conversión.
- `apply/verify-applied.test.ts` (4): verificación de contenido / delete / checks.
- `hu/apply-flow.test.ts` (9): aprobación final, rechazo, request_changes,
  no-aplicar-sin-aprobación, idempotencia tras reinicio SQLite, auditoría,
  applied_with_test_failures.
- Ajustados `reviewers/review-flow.test.ts` y `dev/dev-flow.test.ts`
  (devApprovalTask → finalApprovalTask; aprobar ahora aplica). Deterministas,
  repos temporales (`mkdtempSync`), sin SSO. No tocan el repo real.

---

## 3.13. Fase 14 — Arquitectura: Moderador, Memoria Compartida y Multiagente (COMPLETADA)

Doc detallada: `docs/ARCHITECTURE.md`.

### Objetivo
Definir e implementar los FUNDAMENTOS arquitectónicos para evolucionar hacia una
plataforma de colaboración con IA: multi-runtime, contrato del Moderador,
Knowledge Base compartida, rol auxiliar `assistant` (OpenCode opcional),
contratos de delegación y de integración para Jev, y modelo de capacidades/
permisos. NO se construyó la experiencia conversacional completa ni Jev. KISS,
incremental, sin acoplar los flujos de negocio a herramientas particulares.

### Qué se implementó
- `src/agents/capabilities.ts`: `Capability` (read_repo, read_kb,
  write_kb_proposed, external_docs, propose_changes, apply_changes),
  `PermissionGrant` (allow-list) y `checkPermissions()`. Permisos por TAREA, no
  por runtime. `apply_changes` no lo declara ningún runtime de agente (solo el
  Safe Applier escribe).
- `src/agents/runtime.ts`: `RuntimeDescriptor` + `RuntimeRegistry` +
  `createDefaultRuntimeRegistry({includeOptional})`. Runtimes: kiro, claude,
  opencode (OPCIONAL). Separa capacidades DECLARADAS de permisos CONCEDIDOS.
- `src/agents/opencode-cli-agent.ts`: `OpenCodeCliAdapter` opcional. CLI
  verificado (`opencode run --format json --agent --model`; prompt posicional;
  SIN `--auto`). Solo lectura; nunca escribe el repo.
- `types.ts`: `AgentRole += "assistant"`. `router.ts`: `RuntimeAwareRouter`
  (`hasRuntime`/`forRuntime`); `MapAgentRouter` acepta mapa runtime→adaptador
  opcional. `forRole` intacto (no rompe fases previas).
- `src/moderator/`: contrato `Moderator` + `BasicModerator` determinista
  (conversation/assistance/development), `ModeratorSession`, delegación
  (`DelegatedTask` + `runDelegatedTask` que valida permisos ANTES de ejecutar).
- `src/knowledge/`: Knowledge Base en SQLite (`better-sqlite3`, ya presente; sin
  deps nuevas). Categorías, estados (proposed/approved/superseded/archived),
  relaciones, historial. `approve()` EXIGE actor humano (agentes lanzan).
- `src/core/jev-contracts.ts`: `JevQueryPort` (solo lectura) + `JevCommandPort`
  (Core ejecuta, Jev transmite) + `JevCorePort`. Sin frontend/WS/voz.

### Reglas duras (verificadas por tests)
- Roles NO acoplados a proveedores; un rol puede correr con runtimes distintos.
- Adaptadores existentes intactos; OpenCode registrable y OMITIBLE.
- El moderador: pregunta técnica NO inicia desarrollo; solo escala con
  autorización explícita; no salta aprobaciones ni ejecuta el Safe Applier.
- Delegación: permisos validados antes de ejecutar; `apply_changes` bloqueado en
  tareas auxiliares; resultado de agente NUNCA es decisión aprobada.
- KB: ningún agente promueve a `approved`; `superseded` conserva historial;
  persiste entre reinicios.
- Ningún agente escribe el repo fuera del Safe Applier.

### Pruebas (171 en 22 archivos; +23 de Fase 14)
- `agents/runtime.test.ts` (8): casos 1,2,3,13 + selección por runtime +
  apply_changes no declarado + supports().
- `moderator/moderator.test.ts` (9): casos 4,5,6,7,12,13 + resultado no
  auto-aprobado + sesión sin duplicar estado.
- `knowledge/kb-store.test.ts` (6): casos 8,9,10,11,14 + relaciones no
  duplicadas. Caso 15 (fases 1-13) cubierto por la suite completa verde.
Deterministas, dobles sin CLIs reales. No tocan el repo real.

### Limitaciones / pendientes
- Moderador determinista (no LLM): fundamento, no experiencia final.
- `better-sqlite3` sin tipos → declaración local mínima (no se instaló @types).
- Integración extremo a extremo moderador→Core→grafo: contratos y punto de
  integración definidos, no cableados en un ejecutable.
- Recuperación semántica de la KB: preparada, no implementada (sin vectores/RAG).

---

## 3.14. Fase 15 — Integración extremo a extremo (COMPLETADA)

Doc detallada: `docs/INTEGRATION.md`.

### Objetivo
CONECTAR los componentes de fases 9-14 en un flujo funcional de punta a punta:
Entrada → Moderador → Core → Runtime/Agente → Grafo → Knowledge Base → Resultado.
Sin reimplementar nada, sin Jev, sin LLM, sin RAG, sin debilitar la seguridad.

### Diagnóstico previo
Todo lo de fases 9-14 ya funcionaba; faltaba el CORE que uniera moderador +
delegación + grafo + KB. Los contratos de Fase 14 eran suficientes: NO se
necesitaron cambios arquitectónicos ni se modificó ningún contrato. El único
ajuste previsto por el propio contrato: el Core construye la `DelegatedTask` de
asistencia con el grant de solo lectura.

### Qué se implementó
- `src/core/saiki-core.ts`: `SaikiCore implements JevCorePort`. `process()`
  clasifica con el moderador y enruta: conversation (reply) / assistance
  (DelegatedTask SOLO LECTURA → runDelegatedTask → OpenCode) / development
  (`buildHuGraph.invoke` con thread_id; pausa en aprobaciones). `submitApproval`
  reanuda el grafo (`Command resume`). `getFlowStatus`/`getPendingProposal` leen
  el grafo real. KB: `proposeKnowledge` (proposed), `searchKnowledge`,
  `requestKnowledgeApproval` (exige humano). NO escribe el repo por ningún
  camino: solo el grafo→Safe Applier.
- `src/core/core-store.ts`: `CoreStore` (SQLite) persiste sesiones+tareas SIN
  duplicar el estado de LangGraph (referencia `developmentThreadId`).
- `src/manual/e2e-integration.ts` + `npm run manual:e2e`: demo opt-in con
  componentes reales; aplicación en copia temporal (protección Fase 13).

### Pruebas (180 en 23 archivos; +9 de Fase 15)
`src/core/saiki-core.test.ts`: los 8 escenarios de aceptación + end-to-end
aprobado que aplica vía grafo/applier. Deterministas, dobles sin CLIs reales,
KB/CoreStore en `:memory:`, checkpointer memory/SQLite temporal. Fases 1-14
siguen verdes.

### Seguridad (no debilitada)
Aprobaciones humanas conservadas (interrupts del grafo); el Core solo las
transmite. Escritura SOLO vía Safe Applier dentro del grafo. Asistencia solo
lectura (nunca apply_changes). Conocimiento oficial exige actor humano. Errores
de runtime explícitos (failed, sin result).

### Limitaciones / pendientes
- Moderador aún determinista (la inteligencia conversacional es la Fase 16).
- Jev no se construyó (solo la fachada `JevCorePort`, implementada por el Core).
- Relación solicitud↔ejecución↔conocimiento a nivel de sesión; sin grafo de
  relaciones más rico (no se necesitaba). KB sin recuperación semántica.

---

## 3.15. Fase 16 — Moderador conversacional inteligente (COMPLETADA)

Doc detallada: `docs/MODERATOR.md`.

### Objetivo
Evolucionar el moderador determinista (Fase 14) a uno basado en LLM, capaz de
comprender lenguaje natural, mantener contexto, aclarar ambigüedades, enrutar y
sintetizar resultados. INDEPENDIENTE del proveedor. KISS, reutilizando lo hecho.

### Diagnóstico previo
`SaikiCore` ya inyecta el moderador y enruta; `ModeratorSession.turns[]` ya tenía
el historial (base del contexto); `ClaudeCliAdapter` ya usa `ProcessRunner`
inyectable. Único ajuste aditivo: el contrato `Moderator` era síncrono; un LLM es
asíncrono → se añadió `AsyncModerator` sin romper el síncrono.

### Qué se implementó
- `src/moderator/conversation-engine.ts`: contrato `ConversationEngine`
  (`complete({prompt, systemHint?})`), runtime conversacional intercambiable.
- `src/moderator/claude-conversation-engine.ts`: `ClaudeConversationEngine`
  reutiliza `spawnProcessRunner` con flags SOLO TEXTO (sin herramientas),
  prompt por stdin, timeout/tope de bytes. Separado del rol `develop`. No simula.
- `moderator-types.ts` (aditivo): `RichIntentCategory` (+clarification),
  `RichClassification`, `AsyncModerator`.
- `src/moderator/llm-moderator.ts`: `LlmModerator`. `classifyAsync` arma prompt
  con historial + esquema, pide JSON, `parseClassification` valida (tolerante a
  markdown, clampa confianza); fallo/JSON inválido → `ModeratorEngineError`
  (explícito, sin simular). `respond` enruta conversation/assistance/development/
  clarification. `synthesizeAssistance` diferencia hecho/hipótesis/recomendación
  y conserva referencia; no inventa si la tarea falló.
- `src/core/saiki-core.ts`: acepta `Moderator | AsyncModerator` (detección por
  `respond`); `decide()` normaliza ambos; nueva categoría `clarification`
  (pregunta y NO ejecuta). Reglas de enrutamiento y seguridad SIN cambios.
- `src/manual/moderator-integration.ts` + `npm run manual:moderator`: demo opt-in
  con Claude real integrado en el Core (conversación multi-turno).

### Seguridad (no debilitada)
La confianza del modelo NO autoriza acciones sensibles. El moderador NO escribe,
NO aplica, NO aprueba (código ni KB), NO salta aprobaciones. El motor corre en
modo solo texto. El desarrollo sigue pasando por el grafo y sus aprobaciones.

### Cambio de proveedor
Implementar otro `ConversationEngine` e inyectarlo en `new LlmModerator(engine)`.
El Core NO cambia (escenario 10 probado).

### Pruebas (199 en 24 archivos; +19 de Fase 16)
`moderator/llm-moderator.test.ts` (15: escenarios 1-9 + síntesis + confianza no
autoriza + robustez de parseo) y `core/saiki-core.test.ts` (+4: development async,
clarification, cambio de proveedor sin tocar el Core, error del proveedor
propagado). Deterministas con un `ConversationEngine` falso. Fases 1-15 verdes.

### Limitaciones / pendientes
- Depende de la calidad del modelo; ante la duda usa `clarification`.
- Contexto por sesión (sin memoria larga entre sesiones; la KB cubre lo
  persistente). Jev no construido. KB sin recuperación semántica.

---

## 3.16. Fase 17 — Síntesis de asistencia integrada en el Core (COMPLETADA)

Doc detallada: `docs/ASSISTANCE.md`.

### Objetivo
Cerrar el ciclo de asistencia: tras una investigación exitosa, el Core invoca
automáticamente `synthesizeAssistance` del moderador y entrega una respuesta
natural y fundamentada. KISS, reutilizando contratos.

### Diagnóstico previo
La rama de asistencia ya ejecutaba `runDelegatedTask` pero devolvía el resultado
crudo. `synthesizeAssistance` existía solo en `LlmModerator` (no en contrato).
Solución aditiva (sin tocar contratos fundamentales): interfaz opcional
`AssistanceSynthesizer`, campo `DelegatedTask.synthesis?`, type-guard
`canSynthesize` en el Core.

### Qué se implementó
- `moderator-types.ts`: `AssistanceSynthesizer { synthesizeAssistance(task) }`
  (opcional). `delegation.ts`: `DelegatedTask.synthesis?` (idempotencia).
- `saiki-core.ts`: rama de asistencia reescrita. Si la investigación tiene éxito,
  `trySynthesize(done)` produce la síntesis, se persiste en `done.synthesis`, se
  añade un turno del moderador y se devuelve como `reply`. Robustez:
  investigación fallida → error explícito sin síntesis; síntesis fallida →
  resultado crudo conservado + aviso; moderador sin síntesis → crudo + nota;
  tarea recuperada con `synthesis` → NO re-sintetiza.

### Seguridad (no debilitada)
OpenCode solo lectura; el moderador no modifica/aplica/aprueba; Safe Applier y
flujo de desarrollo intactos; sin aprobaciones automáticas.

### Pruebas (208 en 24 archivos; +9 de Fase 17)
`core/saiki-core.test.ts` (bloque Fase 17): los 8 escenarios de aceptación +
moderador sin síntesis. Deterministas con `ConversationEngine` falso. Fases 1-16
verdes.

### Limitaciones / pendientes
- `DelegatedTask.evidence[]` existe pero `runDelegatedTask` aún no la puebla
  (OpenCode devuelve texto); la síntesis parte de `task.result`.
- La síntesis depende de la calidad del modelo (parte solo del resultado real).

---

## 3.17. Fase 18 — Auditoría del backend y diseño de API (COMPLETADA, solo auditoría)

Doc detallada: `docs/BACKEND_AUDIT.md`. **No se escribió código de producción**:
fase de auditoría y diseño. 208 tests siguen verdes (sin cambios de código).

### Hallazgos clave (verificados)
- **NO existe servidor HTTP** ni dependencia de red (`grep` sin coincidencias
  salvo comentarios que lo prohíben; `package.json` solo tiene 3 deps LangGraph).
  Saiki-IA es un backend EMBEBIDO POR BIBLIOTECA vía `SaikiCore`.
- **NO existe bus de eventos** de dominio (solo `child.on`/`rl.on`). El
  seguimiento es por POLLING (`getFlowStatus`/`getState`).
- Estado de ejecución: parcialmente consultable. Persistido en SQLite (grafo,
  sesiones/tareas, KB). FALTA una "vista de ejecución" normalizada por etapas
  (entrada→salida, errores, reintentos) consultable por id.
- Aprobaciones: consultables por `threadId` (`getPendingProposal` +
  `getFlowStatus`), resolubles con `submitApproval`, atadas al hash, recuperables
  tras reinicio. BRECHA: no hay lock → doble resolución posible; no hay listado
  global de pendientes; no hay identidad verificada de actores.
- Contrato base ideal para API: `JevCorePort` (ya implementado por `SaikiCore`).

### Propuesta (para implementar en fases siguientes, NO ahora)
Capa delgada REST sobre `SaikiCore` (recursos /sessions, /executions,
/knowledge) + SSE para tiempo real (requiere antes un bus de eventos mínimo).
Seguridad: no exponer SQLite, la API no invoca el Safe Applier, validar
identidad+estado+hash al aprobar, lock por threadId, no confiar en el frontend.

### Plan recomendado
Fase 19 = HTTP REST + `ExecutionView` normalizada + lock de aprobaciones.
Fase 20 = bus de eventos + SSE. Fase 21 = Jev (frontend).

---

## 3.18. Fase 19 — API REST local (COMPLETADA)

Doc detallada: `docs/API.md`.

### Objetivo
Capa HTTP REST DELGADA sobre `SaikiCore` (http nativo, 127.0.0.1) para una futura
UI: sesiones, mensajes, ejecuciones (vista normalizada), aprobaciones y KB.
Reutiliza `JevCorePort`; no duplica lógica; no toca grafo ni Safe Applier.

### Qué se implementó
- `src/api/http-server.ts`: `createApiServer({core, humanActor, port?, host?})`
  con `http` nativo (sin Express). 127.0.0.1, puerto `SAIKI_API_PORT` (default
  4123). Rutas: /health, /sessions (POST/GET), /sessions/:id (GET),
  /sessions/:id/messages (POST), /executions/:threadId (+/stages,/result,
  /approval GET), /executions/:threadId/approval (POST), /knowledge (GET),
  /knowledge/:id (GET). `handle.ready` (promesa de listening) + `close()` ordenado.
  Errores centralizados, JSON consistente, mensajes saneados (no filtran stderr).
- `src/core/execution-view.ts`: `ExecutionView` + `projectExecution` (proyecta
  HuState a 9 etapas sin exponerlo; honesta available/unavailable/not_applicable;
  campo `events?` reservado para F20). `SaikiCore.getExecution(threadId)`.
- `src/core/approval-lock.ts`: `KeyedMutex` (mutex POR threadId, no global).
- `SaikiCore.resolveApproval(threadId,{decision,proposalHash,actor,feedback})`:
  bajo el lock verifica existencia + awaitingApproval + hash==pendiente, reanuda
  el grafo, registra identidad/decisión/hash/fecha. Rechaza hash desactualizado
  (409) → evita doble aplicación.
- `src/api/serve.ts` + `npm run serve`: arranque local con Core real (identidad
  `SAIKI_HUMAN_ACTOR`, aplicación en copia temporal salvo SAIKI_APPLY_TO_REAL_REPO=1).

### Seguridad (local)
Solo 127.0.0.1. Identidad del SERVIDOR, no del body. Sin ruta directa al Safe
Applier. Aprobación atada al hash. Errores saneados. Limitación: identidad única
local, sin auth multiusuario (evolución futura).

### Pruebas (221 en 25 archivos; +13 de Fase 19)
`src/api/http-server.test.ts`: servidor en puerto efímero + fetch real a
127.0.0.1, cubre los 15 escenarios de aceptación (incl. doble aprobación
simultánea 200+409, hash incorrecto 409, reinicio sin pérdida, ningún endpoint
salta el Safe Applier). Dobles deterministas, sin CLIs reales. Fases 1-18 verdes.

### Limitaciones / pendientes
- `ExecutionView.runtime` por etapa = unavailable (no persistido; brecha de F18).
- Sin eventos/SSE (polling): es la Fase 20. Sin auth multiusuario.

---

## 3.19. Fase 20 — Bus de eventos y SSE (COMPLETADA)

Doc detallada: `docs/EVENTS.md`.

### Objetivo
Eventos de dominio + endpoint SSE para observación en tiempo real. Reutiliza el
Core y la API REST (F19). Eventos REALES derivados de puntos observables; sin
instrumentar el grafo ni inventar; sin tocar negocio/seguridad.

### Qué se implementó
- `src/events/event-types.ts`: `SaikiEvent` tipado (10 tipos + `data` por tipo),
  `seq` por ejecución (= Last-Event-ID).
- `src/events/event-bus.ts`: `EventBus` publish/subscribe con AISLAMIENTO (un
  suscriptor que lanza no detiene el Core ni a otros).
- `src/events/event-store.ts`: `EventStore` (better-sqlite3) con `seq` por
  ejecución, `getSince` (reconexión), retención por ejecución, `earliestSeq`.
- `SaikiCore`: `eventBus`/`eventStore` opcionales. `emitStageDiff` emite solo
  etapas que cambiaron (idempotente → no duplica al reanudar). Emisión en puntos
  reales: process development (execution.started + progreso), submitApproval
  (progreso tras reanudar), resolveApproval (approval.resolved), assistance
  (assistant.message), proposeKnowledge (knowledge.proposed).
- `src/api/http-server.ts`: endpoint SSE `GET /executions/:id/events` (text/
  event-stream, Last-Event-ID, heartbeat, cierre limpio sin interrumpir la
  ejecución, control `gap` si se piden eventos por debajo de la retención).
- `serve.ts` cablea bus+store (`.saiki/events.sqlite`).

### Honestidad de los eventos
En la primera pausa (aprobación HU) se emite `stage.completed`(hu_analysis) +
`approval.required`, NO `stage.started` (ninguna etapa queda running con el grafo
pausado). La granularidad de `stage.*` es la del `ExecutionView`, no por nodo
interno. No se instrumenta el grafo.

### Pruebas (237 en 27 archivos; +16 de Fase 20)
`events/events.test.ts` (6: aislamiento, seq, getSince, retención) +
`api/sse.test.ts` (10: emisión real, cliente SSE en vivo, reconexión con
Last-Event-ID, desconexión no interrumpe, sin duplicar al reanudar, sin secretos,
404). Deterministas, sin CLIs reales. Fases 1-19 verdes.

### Compatibilidad
REST de F19 intacto; `ExecutionView` compatible (solo se añadió `events?`). UI
futura: REST para consultas/acciones + SSE para tiempo real. Sin WebSocket.

---

## 3.20. Mini-fase backend 21 — Puertas HU y viabilidad parcial por HTTP (COMPLETADA, 2026-10-30)

Doc detallada: `docs/API.md` §5.1. Motivo: `docs/FRONTEND_PROPOSAL.md` (hallazgo 1).

### Problema
Toda ejecución iniciada por la API quedaba pausada en `hu_review`: el único
endpoint de aprobación exigía una `devProposal` (409 `not_awaiting`). Los tests
de F19/F20 la saltaban llamando a `core.submitApproval` directamente.

### Qué se implementó
- `POST /executions/:id/approval/:kind` (`hu_review` | `feasibility_partial`),
  body `{ decision, decisionHash, feedback? }`; errores 400/404/409
  (`not_awaiting` con `pendingKind`, `hash_mismatch` con `expectedHash`,
  `unsupported_decision`).
- `GET /executions/:id/approval` añade `gate`; `pendingApproval` y los eventos
  `approval.*` añaden `decisionHash`/`kind` (todo aditivo). El endpoint de
  propuesta (`proposalHash`) queda intacto.
- `SaikiCore.getPendingGate` / `resolveGate`: mismo `KeyedMutex`, misma
  auditoría (`recordHumanDecision`, compartida con `resolveApproval`); exige que
  el grafo esté PAUSADO en esa puerta (interrupt real).
- Hashes SHA-256 deterministas derivados del checkpoint: `hashHuReview` (incluye
  nº de versión) en `src/hu/hu-schema.ts`; `hashFeasibilityDecision` en
  `src/dev/feasibility.ts`. Sin estado nuevo en el grafo.
- Corrección: `submitApproval` traduce la decisión por puerta (HU:
  `request_changes`→`revise`; viabilidad: `approve`→`proceed`) y rechaza las no
  admitidas. Antes, esas combinaciones se interpretaban en silencio como rechazo.
  La viabilidad parcial no tiene ruta de "pedir cambios" en el grafo: 400.

### Verificación
- Tests: 252 en 28 archivos (+15 en `src/api/gates.test.ts`), typecheck limpio.
  Agentes deterministas; aprobaciones reales por HTTP. Mutación de control:
  quitar la comprobación de hash o la de pausa real hace fallar 2 y 4 tests.
- Flujo REAL solo por HTTP (2026-10-30, `npm run serve`, Kiro CLI 2.36.0 con
  SSO, Claude Code 2.1.251, aplicación en copia temporal). Solicitud: "clamp en
  src/utils/clamp.ts". Resultado:
  1. `POST /messages`: moderador (Claude) → `development`, 22 s. HU de Kiro con
     5 tareas, 7 criterios y 3 preguntas abiertas → pausa `hu_review`.
  2. `POST /approval/hu_review` approve: 200 en 58 s. El análisis técnico (Kiro)
     mantuvo 3 preguntas → `partially_ready` → pausa `feasibility_partial`
     (apareció de forma natural, no forzada).
  3. `POST /approval/feasibility_partial` approve: 200 en 126 s. Claude propuso,
     la revisión funcional pidió un cambio (1 ciclo de corrección), ambas
     revisiones aprobaron el mismo hash → `final_approval`.
  4. Repetir las decisiones de HU y viabilidad: 409 `not_awaiting`
     (`pendingKind: final_approval`). Hash de propuesta viejo: 409.
  5. `POST /approval` approve: `applied`; 9/9 etapas `done`, sin errores. Los
     2 archivos creados en la copia temporal; el test generado pasa (7/7). El
     repo real no se tocó. Auditoría de las 3 decisiones en la sesión.
- Durante el paso 1 se confirmó que `GET /executions/:id` muestra el avance real
  (`hu_analysis` en curso) mientras la petición sigue abierta (hallazgo 4 de la
  propuesta frontend).

### No verificado / limitaciones reales
- Con agentes reales NO se ejercitaron: `request_changes` y `reject` en ambas
  puertas, el agotamiento del cupo de revisiones de HU, la concurrencia ni el
  reinicio del servidor a mitad del flujo. Todo eso está cubierto SOLO por tests
  con agentes deterministas.
- Una sola ejecución real: no demuestra la estabilidad de Kiro/Claude ante otras
  solicitudes (p. ej. timeout de Kiro, 60 s por defecto; en esta prueba ninguna
  llamada lo superó).
- Las peticiones de decisión BLOQUEAN hasta que el grafo vuelve a pausarse o
  termina (58 s y 126 s en la prueba real).
- `approval.resolved` se emite DESPUÉS de los eventos de la ejecución reanudada.
- El diff de etapas vive en memoria: tras reiniciar el backend se re-emiten
  `stage.*` ya publicados (comportamiento previo de F20, sin cambios).
- Agente/runtime y duración por etapa siguen sin registrarse en el backend.

---

## 3.21. Fase 21 — Jev, interfaz web (COMPLETADA, 2026-10-30)

Plan, decisiones y hallazgos: `docs/FRONTEND_PROPOSAL.md`. Uso: `web/README.md`.

### Qué se construyó
Sub-proyecto independiente `web/` (Vite 8 + React 19 + TypeScript + React Router 8
+ TanStack Query 5, CSS Modules + variables CSS, EventSource; sin Tailwind ni
librerías de componentes). Consume solo REST + SSE vía proxy `/api` de Vite; no
importa nada de `src/`, no accede a SQLite, no envía `actorId`.
- Inicio: nueva solicitud, ejecuciones que necesitan intervención, recientes.
- Sesión: conversación, tareas de asistencia (rol/runtime), enlace a la ejecución.
- Ejecución: pipeline de 9 estaciones con señales HU/viabilidad, inspector de etapa
  («Tiempo observado» solo con inicio y fin vistos por el sondeo), registro SSE con
  reconexión, diálogos de decisión (HU, viabilidad parcial, propuesta final) y
  resultado final.
- Conocimiento: búsqueda y lectura de la KB (solo lectura).

### Verificado (real, con Kiro y Claude, solo por la UI)
Solicitudes enviadas desde la UI; sondeo en vivo; eventos SSE en vivo; caída y
relanzamiento del backend sin duplicar eventos; pedir cambios en la HU con 409
`hash_mismatch` entre dos pestañas; viabilidad parcial; aprobar y aplicar
(`applied`, en copia temporal); rechazar HU (`rejected`); no desarrollar
(`blocked`); tiempo observado real (análisis técnico ≈ 47 s ±5 s); resultado final
con archivos coincidentes con la versión aprobada; AccessLint a 0 violaciones en
7 pantallas. `web/`: 55 tests (Vitest), typecheck y build limpios.

### No verificado / limitaciones reales
- La KB real está vacía: la vista de Conocimiento solo se probó con su estado
  vacío y con tests de etiquetas/filtros.
- El diálogo no se pudo escanear con AccessLint (requiere interacción); revisado a
  mano por teclado, no con lector de pantalla real.
- Sin pruebas de componentes (no hay jsdom/testing-library); la UI se verificó en
  Chrome real controlado por CDP.
- Backend (no tocado, candidatos a mini-fase): hallazgo 13 (texto de estado
  "esperando interacción" durante la ejecución), 14 (Ctrl+C colgado con clientes
  SSE abiertos), 15 (la API no devuelve los archivos de una propuesta ya
  resuelta). Agente/runtime y duración por etapa siguen sin registrarse.
- Producción (servir `web/dist` detrás del mismo origen) fuera de alcance.

---

## 3.22. Mini-fase de estabilización del backend (COMPLETADA, 2026-10-30)

Diagnóstico y diseño aprobados por el dueño. Detalle: `docs/ARCHITECTURE.md`
§10b, `docs/API.md` §4, §5.0 y §5.2, `docs/EVENTS.md` §2 y §5.

### Qué se implementó
- **0. Una ejecución por solicitud**: cada mensaje de desarrollo crea un hilo
  nuevo; la sesión guarda `developmentThreadIds` (aditivo). Antes se reutilizaba
  el hilo: un mensaje reiniciaba una ejecución pausada y reactivaba una terminada
  (demostrado con un experimento antes del cambio). Se releen las sesiones tras
  las esperas largas (condición de carrera con mensajes simultáneos).
- **13. Estado fiel**: `src/core/execution-lifecycle.ts` (clasificación única) y
  `ExecutionView.lifecycle / activity / activeStage / awaitingDecision`
  (aditivos). `activeRuns` en `SaikiCore` (único punto de entrada al grafo:
  `runGraph`). `pendingApproval.required` solo con pausa real. Etapas corregidas
  (HU regenerándose, desarrollo rehecho, revisiones por hash vigente). Evento
  nuevo `execution.stopped` para paradas humanas/políticas. Una decisión durante
  una ejecución activa: `409` inmediato. La aprobación final exige pausa real.
- **14. Cierre y SSE**: registro de clientes SSE; `control: shutdown` y cierre de
  streams y conexiones al apagar; `control: end` en ejecuciones definitivas;
  apagado con plazo de 5 s y salida forzada con un segundo Ctrl+C; emisión
  idempotente reconstruida del `EventStore` (sin duplicados tras reiniciar).
- **15. Historial inmutable**: tablas `proposal_versions` y `human_decisions` en
  `core.sqlite` (solo inserción; triggers contra UPDATE/DELETE); captura desde el
  historial de checkpoints tras cada tramo; reconstrucción de ejecuciones
  anteriores (checkpoints + `approval.resolved`); endpoints `GET
  /executions/:id/proposals`, `/proposals/:hash`, `/decisions`. `resolvedAt` es
  el momento en que se acepta la decisión (corregido durante la prueba real:
  antes se registraba al terminar el tramo).
- **Jev adaptado**: usa `lifecycle`/`awaitingDecision` (sin deducciones), una fila
  por ejecución en el inicio, lista de ejecuciones en la sesión, `control: end`
  ("Eventos: Finalizada"), resultado final con historial de propuestas y
  decisiones del backend (se eliminó el registro "propuestas vistas").

### Verificado
- Backend: 281 tests en 29 archivos (+29 en `src/api/stabilization.test.ts`),
  typecheck limpio. Mutaciones de control: sin reconstrucción desde EventStore,
  cierre antiguo, sin triggers, sin reconstrucción desde eventos y fecha de
  decisión tardía hacen fallar su test.
- `web/`: 58 tests, typecheck y build limpios.
- Flujo REAL solo por HTTP (Kiro + Claude, backend con el código nuevo en un
  puerto aparte, aplicación en copia temporal): `running` con etapa activa real
  en cada tramo; ejecución B en la misma sesión sin alterar A; B detenida no
  revive con C; `execution.stopped`; `control: end`; A con pedir cambios sobre la
  propuesta final → v1 `changes_requested` con observación y v2 `approved`
  aplicada; apagado con cliente SSE en 0,17 s (`control: shutdown`); tras
  reiniciar, historial y eventos idénticos y sin re-emisiones. Fecha de decisión
  real: registrada al enviarla (13:23:49) y no al terminar Kiro (13:24:03).
- Jev contra el backend nuevo: tres ejecuciones de una sesión visibles por
  separado; resultado con historial y decisiones.

### No verificado / limitaciones reales
- Las 4 decisiones de la primera prueba real (sesión `stab-real`) quedaron
  registradas con la fecha antigua (fin del tramo): el historial es inmutable y
  no se reescribe. Las decisiones reconstruidas de eventos antiguos usan la hora
  del evento y no tienen observaciones.
- `interrupted` se probó con un "reinicio" simulado en test (proceso nuevo sobre
  los mismos SQLite con el anterior a mitad), no matando el backend real a mitad
  de un tramo. No hay reanudación de ejecuciones interrumpidas.
- `currentStage` sigue existiendo (obsoleto, por compatibilidad).
- Sin cancelación de ejecuciones (fuera de alcance por decisión del dueño).
- Agente, runtime y duración por etapa: evaluados, no implementados (fase
  posterior; el historial de checkpoints ya tiene las horas de cada paso).
- El backend que el dueño tenía abierto durante la fase sigue ejecutando el
  código anterior hasta que se reinicie.

---

## 3.23. Fase Project Registry — varios proyectos locales (COMPLETADA, 2026-10-30)

Diseño y decisiones D1–D9 aprobados por el dueño (con 8 precisiones
obligatorias): `docs/PROJECT_REGISTRY_PROPOSAL.md`. Detalle técnico:
`docs/ARCHITECTURE.md` §10c y `docs/API.md` §3 (Proyectos, Sesiones) y §5.3.

### Qué se implementó (10 tareas, cada una con pruebas)
1. **Registro** (`src/projects/project-registry.ts`, `project-fs.ts`): tablas
   `projects` (identidad inmutable por trigger, sin borrado) y `project_history`
   (solo inserción, actor y fecha). Exige repo git (D1, `.git` directorio o
   `gitdir:`), guarda `realpath` (D3), huella `{dev, ino, gitDir, gitIno}`,
   rechaza rutas sensibles, duplicados (por ruta real o directorio git) y
   anidamiento; salud calculada al leer.
2. **API**: `POST/GET/PATCH /projects`, `/projects/:id/history`, `/activate`,
   `/deactivate`. Ruta no editable (D2). `real` exige `confirmRealApply` (D4).
3. **Sesiones con proyecto**: `POST /sessions {projectId}` persiste; el proyecto
   de una sesión no se reasigna (409 y trigger SQLite).
4. **Desarrollo exige proyecto** y se revalida al iniciar; si no, aclaración con
   `blockedReason` (D6), sin ejecución.
5. **Vinculación inmutable**: `HuState.project` (reducer keep-first) +
   `execution_projects` (solo inserción); `ExecutionView.project` y `applyTarget`.
   D5: desactivar con ejecuciones pausadas sí; trabajando, 409.
6. **Nodos y agentes**: el Core construye el grafo con `requireProject: true`;
   cada nodo lee la raíz de `state.project`; `context.workingDirectory` →
   `ProcessRequest.cwd` en Kiro, Claude y OpenCode. Asistencia: repo del proyecto
   o directorio vacío (D8).
7. **Guardia de aplicación** (`src/projects/apply-guard.ts`) justo antes de
   escribir y **sandbox por ejecución** (copia completa sin `.git`, dependencias
   ni build). Real solo si lo era al vincular y lo es ahora. `.git/` y `.saiki/`
   protegidos. Sin fallback de ruta.
8. **Compatibilidad**: sesiones antiguas → generales; ejecuciones antiguas
   (`project: null`) solo admiten `reject` (`409 project_unbound`), nunca se
   aplican sobre el directorio del backend (precisión 6). D9 en
   `src/projects/home-project.ts` (lo llama `serve.ts`).
9. **Jev**: vista `/projects` (registrar, renombrar, modo, activar/desactivar,
   historial), selector de proyecto en el inicio ("Sin proyecto (solo
   conversación)"), proyecto en filas, columna lateral, sesión y ejecución,
   avisos de bloqueo, destino de la aplicación en el diálogo y "Aplicado en".
10. Documentación y validación real.

### Corregido durante la validación real
- **El moderador (Claude) arrancaba en el directorio del backend** (observado con
  `lsof` sobre los procesos reales; Claude CLI carga el CLAUDE.md del directorio
  en que arranca). Ahora cada llamada del motor conversacional corre en un
  directorio vacío propio que se borra al terminar. Verificado tras reiniciar.
- Jev: el titular de `apply_blocked` presuponía un problema de hash; ahora es
  neutro y el motivo viene del backend. Errores del formulario de registro que
  seguían visibles tras editar.

### Verificado
- Backend: 347 tests en 36 archivos, typecheck limpio. Web: 67
  tests, typecheck y build limpios. AccessLint: 0 violaciones en Proyectos,
  Inicio con selector, sesión general y ejecución bloqueada.
- Validación REAL con Kiro y Claude (backend nuevo aislado en el puerto 4124 con
  datos temporales; dos repos git reales: `calc-node` y `notes-flutter`):
  proyectos registrados desde Jev (con error de ruta sin git, duplicado y
  confirmación de real comprobados); tres ejecuciones en paralelo (dos por API,
  una desde el compositor de Jev); los 18 procesos de agentes del flujo
  observados por `lsof` arrancaron en el repo de su ejecución; propuestas solo con
  archivos de su repo; A2 aprobada desde el diálogo de Jev (que mostraba el
  destino sandbox) y aplicada en su sandbox, con ambos repos reales idénticos byte
  a byte; tras reiniciar el backend, vinculaciones idénticas; calc-node
  desactivado con A3 pausada → `apply_blocked` sin sandbox ni escrituras;
  notes-flutter movido con B1 pausada → `apply_blocked` ("ya no existe; no se
  busca en otra ruta"), el repo movido intacto; devuelto a su ruta, salud `ok`.
  Moderador real en una sesión general: `project_required`, sin ejecución.

### No verificado / limitaciones reales
- **D9 en este equipo**: el directorio de Saiki-IA **no es un repositorio git**,
  así que el registro automático no lo registra (respeta D1) y lo explica al
  arrancar. Para mantener el uso actual hay que ejecutar `git init` en él (o
  registrarlo desde Jev tras hacerlo). Decisión pendiente del dueño.
- La aplicación en modo `real` se probó en tests de integración con repos
  reales, no en la validación con agentes reales (que usó sandbox).
- En la validación real, una ejecución (A1) terminó en `dev_failed` porque Claude
  devolvió JSON inválido: fallo del agente, ajeno al registro; el flujo lo marcó
  como fallido sin fingir éxito.
- Riesgo residual documentado: `fs_read` de Kiro no está confinado al proyecto
  (lectura). Sin sandbox de sistema operativo (fuera de alcance).
- Los sandboxes de las ejecuciones se crean en el temporal del sistema y no se
  limpian automáticamente.
- Los scripts manuales `manual:e2e` y `manual:moderator` (fases 15–16) siguen
  usando sesiones sin proyecto: su paso de desarrollo ahora recibe
  `project_required`.
- El backend que el dueño tiene abierto (4123) ejecuta el código anterior hasta
  que se reinicie.

---

## 4. Entorno de desarrollo

> ⚠️ Restricción del dueño: **no modificar configuraciones globales del entorno.**

- **Runtime**: Node.js 22 (probado con v22.23.x). El default global del usuario es
  Node 20 (lo usa para su trabajo) y **no debe cambiarse**.
- **Cómo usar Node 22 sin tocar el default**: vía nvm, por terminal:
  ```bash
  nvm use 22
  ```
  Node 22 se instaló con `nvm install 22 --no-default`.
- **Package manager**: npm.

### Dependencias (pineadas)
| Paquete                | Versión | Rol                                 |
| ---------------------- | ------- | ----------------------------------- |
| `@langchain/langgraph` | 1.5.3   | API Graph (v1 estable)              |
| `@langchain/core`      | 1.3.2   | peer dependency                     |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.0 | checkpointer SQLite durable (Fase 7) |
| `tsx`                  | 4.23.15 | ejecutar TS directo                 |
| `vitest`               | 5.0.5   | pruebas                             |
| `typescript`           | 5.9.3   | tipos / typecheck                   |
| `@types/node`          | ^22.12.0| tipos de Node (ver §5, decisión B)  |

### Comandos
```bash
nvm use 22          # cambiar a Node 22 en esta terminal (no afecta el global)
npm install         # instalar dependencias (primera vez)
npm start           # demo simulada (router solo-mock, rápida, sin créditos)
npm test            # correr pruebas (deterministas, nunca llaman a Kiro)
npm run typecheck   # chequeo de tipos sin emitir
npm run dev         # grafo en watch
npm run test:watch  # tests en watch
npm run manual:kiro # integración REAL Kiro CLI en analyze (requiere kiro-cli login)
npm run manual:claude # integración REAL Claude en develop + aprobación (repo intacto)
npm run manual:tech  # integración REAL Kiro+Claude: HU + técnico + desarrollo (Fases 9-11)
npm run manual:dev   # alias de manual:tech
npm run manual:review # alias: flujo completo hasta revisiones + aprobación humana
```

Nota (Fase 6): `buildGraph` ahora recibe `{ router?, checkpointer?, rootDir? }`
(no un router suelto) y `invoke` requiere `{ configurable: { thread_id } }`.

---

## 5. Decisiones técnicas y problemas resueltos (importante para el futuro)

**A. API moderna de LangGraph.** Se usa `Annotation.Root` para el estado y
`addEdge(START, ...)` / `addEdge(..., END)`. Se evita la API pre-1.0
(`setEntryPoint`/`setFinishPoint`) que sigue compilando pero está desaconsejada
y puede romper en futuros majors.

**B. Conflicto de `@types/node`.** La versión fijada inicialmente (22.10.5) caía
fuera del rango que exige vite/vitest (`^20.19.0 || >=22.12.0`). Solución:
`@types/node@^22.12.0`. Lección: ante un `ERESOLVE`, ajustar la versión al rango
que pide la herramienta en vez de forzar con `--force`/`--legacy-peer-deps`.

**C. Colisión nodo vs. canal de estado.** LangGraph NO permite que un nodo tenga
el mismo nombre que un campo del estado (comparten namespace). Como existe el
campo `review`, el nodo se llama `reviewTask`. **Convención adoptada: campos de
estado = sustantivos (datos); nodos = verbos (`*Task`, acciones).**

**D. Nodos puros y deterministas.** Las funciones simuladas no usan aleatoriedad
ni red, para que el flujo y los tests sean 100% reproducibles. En Fase 2 esto se
logra con el campo `failUntil` (control de simulación), no con random.

**E. (Fase 2) Reducer para acumular.** `attempts` usa un reducer
`(cur, delta) => cur + delta` para que el contador crezca entre pasadas del
bucle. Es el mecanismo que hace posible contar reintentos.

**F. (Fase 2) Enrutar por booleano, no por texto.** La arista condicional lee
`approved` (boolean), no parsea el string `review`. Decidir rutas parseando
texto es frágil; un campo booleano dedicado es robusto.

**G. (Fase 2) Corte explícito del bucle.** El fin del bucle no depende del
`recursionLimit` de LangGraph: se corta con `attempts` vs `MAX_CORRECTIONS` y
una rama garantizada a `failTask → END`.

**H. (Fase 4) Runner de proceso inyectable.** La ejecución del subproceso
(`spawn`) se aísla detrás de `ProcessRunner`. El adaptador recibe el runner por
constructor. Así los tests inyectan un runner falso y son deterministas sin
llamar a Kiro (lento/costoso/flaky). Patrón general para integrar cualquier CLI.

**I. (Fase 4) Seguridad del subproceso.** `spawn` sin shell y args como array
(evita inyección de comandos). Tope de bytes de salida (evita agotar memoria).
Timeout con SIGKILL. Permisos mínimos para `analyze`: `--trust-tools=`
(vacío = ninguna herramienta), nunca `--trust-all-tools`.

**J. (Fase 4) Verificar la sintaxis real de la CLI, no asumirla.** El PO exigió
verificar las opciones contra la versión instalada. Al revisar
`kiro-cli chat --help` (v2.35.2) se encontró un error: se había asumido
`--trust-tools=read`, pero `read` no es un nombre de tool válido (los tools son
`fs_read`/`fs_write`); el valor correcto para "sin herramientas" es
`--trust-tools=` (vacío). Corregido en `kiro-cli-agent.ts` y su test.
El prompt sí era correcto: es el argumento posicional `[INPUT]`.
Lección: los tests con runner falso NO detectan errores de sintaxis del comando
real; por eso existe la prueba de integración manual (`npm run manual:kiro`).

**K. (Fase 4) Contexto del workspace sesga la respuesta.** `kiro-cli` corrido
dentro del proyecto carga el steering/agentes de `.kiro/`, lo que puede sesgar
la respuesta de `analyze`. Con `--trust-tools=` no ejecuta herramientas, pero el
contexto del cwd influye. Tolerable para `analyze`; si molesta, correr desde un
cwd neutral. Documentado en `docs/MANUAL_INTEGRATION_TEST.md`.

**L. (Fase 5) Flags variádicos y el prompt.** `claude --disallowedTools
<tools...>` consume varios valores. Si el prompt va como arg posicional tras un
flag variádico, se "come" el prompt (cada palabra = un tool). Solución general:
pasar el prompt por STDIN. El `ProcessRunner` soporta `stdin`.

**M. (Fase 5) Permisos a nivel de proceso, no de prompt.** Para que un agente
real NO modifique el repo, hay que quitarle las herramientas (`--tools ""`,
`--restricted`, `--disallowedTools`), no confiar en pedírselo en el prompt. Se
verifica empíricamente (repo intacto tras pedirle escribir). La prueba manual
comprueba la integridad del repo con una huella antes/después.

**N. (Fase 6) Aprobación atada a un hash.** "Lo aprobado == lo aplicado" se
garantiza aprobando un SHA-256 de la propuesta estructurada; el aplicador solo
escribe si el hash coincide. Si la propuesta cambia tras aprobarse, el hash
difiere y se exige nueva aprobación. La escritura la hace código nuestro
(aplicador), NO el modelo, y con validación de rutas (anti-traversal/symlink).

**O. (Fase 6) interrupt() requiere checkpointer.** `interrupt()/Command(resume)`
solo funciona si el grafo se compila con un checkpointer y se invoca con
`thread_id`. La pausa NO se simula con sleep/boolean. Verificado en v1.5.3.

**P. (Fase 7) Idempotencia por hash, rollback best-effort honesto.** No aplicar
dos veces: se registra `appliedHash` y una segunda aplicación del mismo hash es
`noop`. El rollback NO es transaccional (el FS no lo es): es snapshot+restaurar,
y si la restauración falla se REPORTA como `unrecoverable` en vez de fingir
éxito. No llamarlo "transaccional".

**Q. (Fase 7) Validación de rutas y realpath.** Comparar symlink escape mezclando
ruta lógica (`resolve`) con física (`realpathSync`) da falsos positivos (p. ej.
`/var`→`/private/var` en macOS). Resolver AMBOS lados con realpath del ancestro
existente. Y contemplar que el directorio raíz puede no existir aún.

**R. (Fase 7) Tests NO deben usar el checkpointer por defecto.** El default es
SQLite persistente en `.saiki/` (repo real); los tests deben inyectar
`createMemoryCheckpointer()` o un SQLite en dir temporal para no compartir
estado ni tocar el repo.

---

## 6. Restricciones y notas del dueño del proyecto

- **Trabajo en local** por ahora.
- **Engram (memoria semántica)**: el usuario lo tiene disponible pero pidió
  explícitamente **NO usarlo todavía**. La memoria por ahora vive en documentos
  (este archivo). No integrar Engram sin pedirlo.
- **`.npmrc` local**: el npm global del usuario apunta a un **JFrog/Artifactory
  corporativo**. Este proyecto tiene un `.npmrc` que fuerza
  `registry=https://registry.npmjs.org/` (registry público). No borrar.
- **No hacer sin confirmación**: frontend, servidor HTTP/WebSocket, Godot,
  agente real para review (analyze=Kiro y develop=Claude ya están hechos),
  ESCRITURA REAL de las propuestas de develop, bases de datos, memoria
  semántica, human-in-the-loop.
- **Kiro CLI auth**: solo login SSO interactivo (`kiro-cli login`). La API key
  headless está bloqueada por la organización SSO corporativa (no reintentar sin confirmación).
- **Rol esperado del asistente**: actuar como desarrollador senior Y tutor.
  Explicar qué se hizo y por qué, e indicar al usuario qué probar y cómo.

---

## 7. Cómo retomar (checklist para la próxima sesión)

1. Leer este archivo y `.kiro/steering/project-context.md`.
2. `nvm use 22` y `npm install` si es un entorno nuevo.
3. Verificar salud: `npm run typecheck && npm test` (252 tests en 28 archivos al
   2026-10-30) y `npm start` (demo del pipeline develop/review). El flujo HU → técnico → viabilidad → Claude →
   revisiones func+calidad → aprobación humana (Fases 9-12) vive en `src/hu/`,
   `src/tech/`, `src/dev/` y `src/reviewers/`. Validación real opt-in:
   `npm run manual:tech` (ver docs/REVIEWS.md, DEVELOPER.md, MANUAL_TECH_INTEGRATION.md).
4. (Opcional) Integración real: `kiro-cli login`, luego `npm run manual:kiro` y
   `npm run manual:claude` (ambos verifican que el repo real queda intacto).
   Ver `docs/MANUAL_INTEGRATION_TEST.md`, `docs/MANUAL_CLAUDE_INTEGRATION.md` y
   `docs/HUMAN_IN_THE_LOOP.md`.
5. Estado actual: backend hasta la estabilización (§3.22) y Jev (§3.21). Probar:
   `npm run serve` en la raíz y `npm run dev` en `web/` (http://localhost:5173).
