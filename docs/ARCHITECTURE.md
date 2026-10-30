# Fase 14 — Arquitectura: Moderador, Memoria Compartida y Multiagente

> Nombre oficial: `saiki-ia`. Esta fase define e implementa los FUNDAMENTOS
> arquitectónicos para evolucionar hacia una plataforma de colaboración con IA.
> NO construye todavía la experiencia conversacional completa ni Jev.

## 1. Principio: separar capas

Se mantienen separados seis conceptos, sin acoplar los roles funcionales a un
proveedor concreto:

| Capa | Qué es | Dónde vive |
|------|--------|------------|
| **Interfaz (Jev)** | Donde interactúa el usuario (futura). | `src/core/jev-contracts.ts` (solo contratos) |
| **Moderador** | Cerebro conversacional; comprende, decide, coordina. | `src/moderator/` |
| **Core** | Orquestación, estado, persistencia, permisos, reglas. | `src/hu/`, `src/apply/`, `src/agents/router.ts` |
| **Knowledge Base** | Memoria compartida del equipo. | `src/knowledge/` |
| **Agentes (roles)** | Responsabilidades: developer, technicalAnalyst, assistant… | `AgentRole` en `src/agents/types.ts` |
| **Runtimes** | Mecanismos de ejecución: Kiro, Claude, OpenCode. | `src/agents/runtime.ts` + adaptadores |

Regla central: **un rol es una responsabilidad, no un runtime.** `developer` no es
Claude; `assistant` no es OpenCode. Kiro/Claude/OpenCode son mecanismos de
ejecución intercambiables.

## 2. Multi-runtime (sin acoplar el Core)

- `AgentAdapter` (contrato de Fase 3) sigue INTACTO. Los adaptadores existentes
  (`KiroCliAdapter`, `ClaudeCliAdapter`) no se migraron.
- `src/agents/runtime.ts`: `RuntimeDescriptor` (id, capacidades DECLARADAS,
  `optional`, fábrica del adaptador) + `RuntimeRegistry` (registrar/consultar/
  comprobar compatibilidad). `createDefaultRuntimeRegistry({includeOptional})`.
- `MapAgentRouter` ahora acepta, además del mapa rol→adaptador, un mapa opcional
  runtime→adaptador, e implementa `RuntimeAwareRouter` (`hasRuntime`,
  `forRuntime`). Así un mismo rol puede ejecutarse con runtimes distintos cuando
  sea compatible, sin tocar nodos ni grafo.

### OpenCode como runtime OPCIONAL

- `src/agents/opencode-cli-agent.ts`: `OpenCodeCliAdapter`. CLI verificado contra
  la documentación oficial: `opencode run <prompt>` con `--format json`,
  `--agent <nombre>`, `--model provider/model`. Deliberadamente SIN `--auto`
  (que auto-aprobaría permisos). El agente OpenCode debe configurarse SOLO
  LECTURA (permisos `read/grep/glob/webfetch/websearch`, nunca `edit/bash`).
- Es opcional: `createDefaultRuntimeRegistry({ includeOptional: false })` lo
  excluye y nada en el Core deja de funcionar. No es dependencia obligatoria.

## 3. Capacidades vs. permisos (seguridad)

`src/agents/capabilities.ts` separa dos conceptos:

- **Capacidades declaradas** por un runtime: su techo técnico.
- **Permisos concedidos** a una TAREA: lo autorizado para esa ejecución.

`Capability` = `read_repo | read_kb | write_kb_proposed | external_docs |
propose_changes | apply_changes`. `PermissionGrant` modela los permisos
concedidos (allow-list; lo omitido se deniega). `checkPermissions(required,
grant)` se invoca ANTES de ejecutar una tarea.

Reglas duras:
- Los permisos se conceden por TAREA, no por el nombre del runtime.
- `apply_changes` NO lo declara ningún runtime de agente: aplicar cambios al
  repositorio es responsabilidad EXCLUSIVA del Safe Applier (`src/apply/`).
- Los agentes auxiliares NO heredan escritura por defecto.

## 4. Moderador (solo contrato en esta fase)

`src/moderator/`:
- `moderator-types.ts`: contrato `Moderator`, `ModeratorSession`,
  `IntentClassification`, `ModeratorDecision`.
- `basic-moderator.ts`: implementación mínima DETERMINISTA (no LLM). Clasifica en
  `conversation | assistance | development` por heurísticas explícitas.
- `session.ts`: estado conversacional (turnos, tareas delegadas, thread de
  desarrollo) SIN duplicar el estado de LangGraph (se referencia por id).

Límites duros (verificados por tests):
- Una pregunta técnica NO inicia desarrollo.
- Solo se escala a `development` con autorización explícita del usuario.
- El moderador NO salta aprobaciones ni ejecuta el Safe Applier; cuando procede
  un desarrollo, solo lo MARCA (`startDevelopment`) y el Core gobierna el flujo.

El moderador conversacional completo (con motor de lenguaje) llega en una fase
futura. La implementación actual es honesta sobre su alcance (`confidence` baja).

## 5. Delegación de tareas

`src/moderator/delegation.ts` + `delegation-runner.ts`:
- `DelegatedTask`: id, solicitud, objetivo, contexto, rol, runtime, capacidades
  requeridas, permisos concedidos, referencias de memoria, estado, resultado,
  evidencias, errores.
- `runDelegatedTask(task, router)`: valida permisos ANTES de ejecutar
  (insuficientes → `blocked`, no se ejecuta); bloquea cualquier tarea con
  `apply_changes`; selecciona adaptador por runtime (o por rol como fallback);
  ejecuta y guarda el resultado como DATO.

**Un resultado de agente NUNCA es una decisión aprobada por sí mismo.** No existe
un campo que lo marque como aprobado; promover conocimiento a oficial es un paso
humano aparte (ver §6).

## 6. Knowledge Base — memoria compartida

`src/knowledge/` (SQLite vía `better-sqlite3`, ya presente; sin nuevas deps):
- Categorías: `architecture, projects, research, decisions, lessons, conventions`.
- Estados (ciclo de vida del conocimiento):

```
  create()                 approve(humanActor)
   │                         │
   ▼                         ▼
proposed ───────────────► approved ───────────► superseded ──► (histórico)
   │  (provisional)          │ (oficial)   supersede()          archive()
   └──────────────────────── └──────────────────────────────► archived
```

- `proposed`: provisional, lo crea cualquier origen (incluido un agente).
- `approved`: oficial. **`approve()` EXIGE un actor humano**; si el actor es un
  agente (assistant/moderator/kiro/claude/opencode), lanza. Ningún agente
  promueve conocimiento oficial por sí mismo.
- `superseded`: reemplazado por otro doc; conserva su historial y registra la
  relación `supersedes` + `supersededBy`.
- `archived`: histórico.

Otras capacidades: búsqueda por texto (LIKE) y metadatos, relaciones entre
documentos, historial de cambios auditable, persistencia entre reinicios.

**Preparada para semántica futura** (búsqueda por texto y metadatos ya existe),
pero SIN base vectorial ni RAG en este MVP (KISS, como pide el enunciado).

## 7. Contratos para Jev (solo límites)

`src/core/jev-contracts.ts`: `JevQueryPort` (consultas de solo lectura),
`JevCommandPort` (acciones que el CORE ejecuta; Jev solo transmite),
`JevCorePort` (fachada). Jev dependerá SOLO de esta interfaz: no conoce los
internos de agentes/runtimes, no ejecuta agentes, no contiene lógica de
aprobación. No se construyó frontend, chat, voz ni WebSockets.

## 8. Persistencia y trazabilidad

- Knowledge Base: SQLite propio (`.saiki/knowledge.sqlite`, gitignored).
- Estado conversacional del moderador: contratos listos para persistir; no
  duplica el estado de LangGraph (flujos y tareas se referencian por id).
- Los flujos de desarrollo siguen en el checkpointer SQLite de LangGraph.

## 9. Las 5 preguntas del PO — respuestas

1. **¿Podemos cambiar Claude por otro runtime sin reescribir el desarrollador?**
   Sí. El rol `develop` resuelve su adaptador por el router; cambiar el runtime
   es cambiar el adaptador registrado, sin tocar nodos ni grafo.
2. **¿Puede OpenCode consultar la memoria compartida sin ser dueño de ella?**
   Sí. La KB es independiente del runtime; OpenCode (rol `assistant`) la consulta
   con permiso `read_kb`; no es su propietario.
3. **¿Puede el moderador delegar una investigación sin iniciar el pipeline de
   desarrollo?** Sí. `assistance` delega una `DelegatedTask` de solo lectura; no
   arranca el flujo de desarrollo.
4. **¿Podrá Jev conectarse sin conocer los detalles internos de los agentes?**
   Sí. Jev depende solo de `JevCorePort`; no conoce agentes ni runtimes.
5. **¿Podemos conservar decisiones y aprendizajes aunque cambiemos de proveedor?**
   Sí. La KB persiste en SQLite, independiente de cualquier runtime.

## 10. Limitaciones y decisiones pendientes

- El moderador es determinista (heurísticas de palabras clave), no conversacional
  todavía. Es un fundamento, no la experiencia final.
- `better-sqlite3` no trae tipos; se añadió una declaración local mínima
  (`src/knowledge/better-sqlite3.d.ts`) para no instalar `@types`.
- La integración "extremo a extremo" moderador→Core→grafo no se cableó en un
  ejecutable; se definieron los contratos y el punto de integración.
- Recuperación semántica de la KB: preparada, no implementada (sin vectores/RAG).
- OpenCode no se ejecutó contra su CLI real en tests (deterministas con dobles);
  su integración real quedaría para una prueba manual opt-in futura.

## 10b. Estabilización del backend (tras la Fase 21)

Hallazgos 13, 14 y 15 de `docs/FRONTEND_PROPOSAL.md` y el hallazgo 0 (una
ejecución no representaba una solicitud). Sin cambiar la orquestación: LangGraph
sigue siendo el orquestador y `SaikiCore` el punto de coordinación.

- **Una ejecución por solicitud**: `process()` crea un hilo nuevo por cada
  desarrollo; nunca reutiliza el de la sesión (eso reiniciaba ejecuciones
  pausadas y reactivaba terminadas). Sesión → `developmentThreadIds`.
- **Ciclo de vida único** (`src/core/execution-lifecycle.ts`): clasifica cada
  ejecución en `running | awaiting_decision | interrupted | completed | failed |
  stopped` para la vista y los eventos. `running` sale de un registro en memoria
  de `SaikiCore` (`activeRuns`, rellenado por `runGraph`, único punto de entrada
  al grafo); `awaiting_decision`, de un interrupt real; tras un reinicio, el
  trabajo pendiente es `interrupted` (no se reanuda solo).
- **SSE y apagado**: registro de clientes SSE en el servidor; `control: end` para
  ejecuciones definitivas y `control: shutdown` al apagar; emisión idempotente a
  partir del `EventStore`.
- **Historial inmutable**: `proposal_versions` y `human_decisions` en
  `core.sqlite` (solo inserción, triggers contra `UPDATE`/`DELETE`). Las versiones
  se capturan del historial de checkpoints (API pública `getStateHistory`), sin
  instrumentar el grafo.
- Fuera de alcance: cancelación de ejecuciones; agente, runtime y duración por
  etapa (evaluado; fase posterior).

## 10c. Registro de proyectos (Project Registry)

Varios repositorios locales, con aislamiento entre ellos. Diseño y decisiones
D1–D9: `docs/PROJECT_REGISTRY_PROPOSAL.md`. Sin infraestructura nueva: el mismo
`core.sqlite`, el mismo grafo, el mismo Safe Applier.

```
Proyecto 1 ── n Sesión (projectId, fijo desde la creación; opcional)
Sesión   1 ── n Ejecución (developmentThreadIds)
Ejecución 1 ── 1 Copia del proyecto (estado del grafo + execution_projects)
```

- **Registro** (`src/projects/project-registry.ts`, `project-fs.ts`): tabla
  `projects` (identidad inmutable por trigger; sin borrado) e historial
  `project_history` (solo inserción, con actor y fecha). Un proyecto es la raíz de
  un repositorio git (D1); se guarda su `realpath` (D3) y una huella (`dev`, `ino`
  del directorio, ruta real e `ino` del directorio git). La ruta no se edita (D2).
  La salud (`ok | missing | moved | not_a_repository | not_accessible`) se calcula
  al leer. Solo el humano lo administra, vía API (`JevProjectPort`); ningún
  agente, ni el moderador ni el grafo, tiene acceso.
- **Sesiones**: `ModeratorSession.projectId`, fijado al crearla e inmutable
  (también por trigger en SQLite). Sin proyecto, la sesión es general: conversa,
  pero un desarrollo responde con una aclaración (`blockedReason`, D6).
- **Vinculación**: `process()` revalida el proyecto (activo y sano) y crea la
  ejecución atada a una copia del proyecto (`ProjectBinding`) en dos fuentes
  independientes: `HuState.project` (reducer que conserva el primer valor) y la
  tabla `execution_projects` (solo inserción).
- **Grafo**: el Core lo construye con `requireProject: true`. Cada nodo resuelve
  el repositorio desde `state.project`; sin proyecto, falla explícitamente en vez
  de usar una ruta global. Los agentes reciben `context.workingDirectory` y los
  adaptadores lo pasan a `spawn({ cwd })`.
- **Guardia de aplicación** (`src/projects/apply-guard.ts`), inyectada como hook
  de `applyTask` y evaluada justo antes de escribir: ambas copias coinciden, el
  proyecto existe, está activo (D5) y conserva su ruta, y el disco sigue siendo el
  mismo repositorio (realpath, `.git`, huella). Si falla: `apply_blocked`, sin
  escrituras y sin buscar otra ruta. Destino: repo real solo si el modo era `real`
  al vincular y lo sigue siendo; si no, un sandbox propio de la ejecución (copia
  completa sin `.git`, dependencias ni artefactos de build; D4). Ninguna propuesta
  puede tocar `.git/` ni `.saiki/`.
- **Sin proyecto, sin repositorio** (D8): la asistencia de una sesión general y
  cada llamada del moderador corren en un directorio vacío temporal, nunca en el
  del backend.
- **Compatibilidad**: las sesiones antiguas pasan a ser generales; las ejecuciones
  antiguas (`project: null`) conservan su historial, pero no se reanudan (solo se
  pueden rechazar: `409 project_unbound`) ni se aplican sobre el directorio actual
  del backend (precisión 6). D9: al arrancar, el backend registra su propio
  directorio como proyecto si es un repositorio git.
- **Riesgo residual**: `fs_read` de Kiro no está confinado a un directorio; un
  agente podría leer fuera del proyecto si lo intenta (solo lectura). Confinarlo
  exigiría un sandbox del sistema operativo (fuera de alcance).

## 11. Archivos relevantes

- `src/agents/capabilities.ts` — capacidades y permisos.
- `src/agents/runtime.ts` — descriptores y registro de runtimes.
- `src/agents/opencode-cli-agent.ts` — runtime OpenCode opcional.
- `src/agents/router.ts` — router rol + runtime (RuntimeAwareRouter).
- `src/moderator/` — contrato del moderador, sesión y delegación.
- `src/knowledge/` — Knowledge Base (tipos + store SQLite).
- `src/core/jev-contracts.ts` — límites de integración para Jev.
- `src/projects/` — registro de proyectos, validación en disco, vinculación,
  guardia de aplicación y registro automático (D9).
- Tests: `src/agents/runtime.test.ts`, `src/moderator/moderator.test.ts`,
  `src/knowledge/kb-store.test.ts`.
