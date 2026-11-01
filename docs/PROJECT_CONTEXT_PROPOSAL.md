# Project Context — diagnóstico y diseño

> Estado: **aprobado (2026-10-30)**, con las decisiones D1–D10 tal como se
> recomiendan y cuatro precisiones del dueño, incorporadas en §6.4
> (`SAIKI_DATA_DIR`), §7.3 (trazabilidad), §9.4 (continuidad del desarrollo) y
> §12.1 (niveles de confianza). Implementación incremental, una tarea por
> revisión. Base: Project Registry (fase 22).

## 1. Resumen ejecutivo

Hoy cada agente recibe solo la HU y la ruta del repositorio, y explora el código
desde cero en cada solicitud. Project Context añade a cada proyecto registrado un
**índice técnico determinista** (estructura, stack, dependencias, scripts,
puntos de entrada, pruebas) que se mantiene al día de forma **incremental**, y un
**conocimiento aprobado por humanos** (arquitectura, convenciones, decisiones).
Antes del análisis técnico, un **Context Builder** arma un contexto acotado y
trazable para los agentes. Ese contexto es orientativo: el código sigue siendo la
fuente de verdad.

Decisiones de diseño principales:

1. **Nada se escribe en los repositorios de los usuarios.** Índice, escaneos y
   conocimiento viven en el directorio de datos del backend (SQLite), aislados
   por `projectId`. Motivos: `.saiki/` ya es el directorio de datos del backend y
   colisiona con el repositorio de Saiki-IA; escribir en el repositorio rompería
   la promesa del modo `sandbox`; y no ensucia el `git status` del usuario (§6).
2. **Determinista primero, LLM solo donde aporta.** Escáner, índice incremental y
   Context Builder son código sin LLM. El LLM solo se usa en el Project Analyst,
   que propone documentación de arquitectura y convenciones para que una persona
   la apruebe.
3. **Sin infraestructura nueva:** SQLite (`better-sqlite3`), JSON, el
   `ProcessRunner` existente para invocar `git`, el bus de eventos y la Knowledge
   Base actual. Sin RAG, embeddings ni dependencias nuevas.
4. **Contexto congelado por ejecución:** cada ejecución fija de forma inmutable
   el *snapshot* del índice que usó y las fuentes exactas que se enviaron
   (caso 9 y trazabilidad).
5. **El contexto nunca bloquea el desarrollo.** Si está desactualizado, se
   refresca de forma incremental con un tiempo límite; si no se puede, se usa el
   último *snapshot* marcado como desactualizado y se avisa al agente y en Jev.

## 2. Diagnóstico de la arquitectura actual (verificado en el código)

| Área | Estado actual | Implicación para Project Context |
|---|---|---|
| Entrada de los agentes | `buildTechnicalPrompt(hu, rootDir)` (`src/tech/tech-instructions.ts`) envía la HU en JSON y la ruta; `buildDevPrompt(ctx)` envía la HU, el análisis técnico y la viabilidad (`src/dev/dev-schema.ts`, `DevContext`). | No hay ningún contexto de proyecto: cada análisis técnico explora el repositorio entero. El punto de inyección natural son estos dos *prompts*. |
| Lectura del repositorio | Analista técnico = Kiro con `fs_read`; desarrollador = Claude sin escritura; ambos con `cwd` = raíz del proyecto (`context.workingDirectory`). Las rutas citadas se verifican en disco (`validateTechnicalAnalysis`, `validateDevProposal`). | Los agentes pueden seguir verificando el código; el contexto solo orienta. La verificación de rutas se reutiliza para el Project Analyst. |
| Viabilidad | `classifyFeasibility` es determinista y se basa en el análisis (`src/dev/feasibility.ts`). | No cambia. |
| Knowledge Base | `KnowledgeStore` (`src/knowledge/kb-store.ts`): SQLite, categorías `architecture/conventions/decisions/...`, estados `proposed → approved`, historial, `approve()` rechaza actores de agente. **Es global (sin `projectId`)**, **`update()` modifica en el sitio incluso documentos aprobados**, y **el grafo no la consume**. La API solo expone lectura (`GET /knowledge`). | Base reutilizable para el conocimiento por proyecto, con dos huecos que cerrar: alcance por proyecto y versiones inmutables de lo aprobado (caso 8). |
| Project Registry | Identidad, `rootPath`, huella `{dev, ino, gitDir, gitIno}`, salud; vinculación inmutable en `execution_projects`; `project` *keep-first* en el estado del grafo. | El escáner valida identidad y huella antes y después de escanear. El contexto se liga a la vinculación de la ejecución. |
| Procesos | `spawnProcessRunner` (`src/agents/process-runner.ts`) con `cwd`, tiempo límite y límite de salida. Hoy el backend no invoca `git`. | Se reutiliza para ejecutar `git ls-files`/`git status` sin dependencias nuevas. |
| Trabajo en segundo plano | `activeRuns` en memoria es la única fuente de "trabajando ahora"; tras reiniciar, el trabajo pendiente se reporta como `interrupted`. | El mismo patrón sirve para los escaneos (caso 5). |
| Eventos | `EventBus` + `EventStore` + SSE; ya existe un evento no ligado a una ejecución (`knowledge.proposed`). | Nuevos eventos `context.*` aditivos. |
| Directorio de datos | `.saiki/` en la raíz desde la que arranca el backend (= el repositorio de Saiki-IA, hoy un proyecto registrado). Está en `PROTECTED_DIRS` (las propuestas no pueden escribir en él) y en `SANDBOX_EXCLUDED`. | Un `.saiki/` por repositorio colisionaría en Saiki-IA con las bases de datos del backend. |
| Frontend | Jev ya tiene `ProjectsPage`, `KnowledgePage` y `KnowledgeDocPage`, y SSE. | Se amplía; no hace falta una arquitectura nueva. |

## 3. Componentes reutilizables

- `ProjectRegistry`, `checkProjectHealth`, `readFingerprint`, `sameFingerprint` e
  `isWithin` (`src/projects/project-fs.ts`): validación de la raíz y de los
  enlaces simbólicos.
- `spawnProcessRunner`: ejecución de `git` con `cwd`, tiempo límite y límite de
  salida.
- `CoreStore` y su patrón de tablas de solo inserción con *triggers*
  (`execution_projects`): congelar el contexto por ejecución.
- `KnowledgeStore`: estados, historial y regla "solo humanos aprueban".
- `AgentRouter` y los adaptadores Kiro/Claude/OpenCode: el Project Analyst como
  un rol más, sin acoplarse a un proveedor.
- Validadores de rutas de `tech-schema`/`dev-schema`: verificar que el Project
  Analyst cita archivos reales.
- `EventBus`/`EventStore`/SSE y `JevCorePort` como fachada.
- Utilidades de prueba `TempRepos`, `openDevSession` y `FlowAgent`.

## 4. Arquitectura propuesta

```text
                      ┌──────────────── SaikiCore (fachada JevContextPort) ───────────────┐
 registro / manual /  │                                                                   │
 tras aplicar real ──▶│  ScanScheduler ──▶ ProjectScanner ──▶ Extractors (node, angular,   │
                      │   (1 por proyecto,   (listado, clasif.,   ionic, flutter, genérico)│
                      │    2 en total)        hash incremental)          │                │
                      │        │                                         ▼                │
                      │        └────────────▶ ContextStore (context.sqlite)               │
                      │                        scans · files · snapshots                  │
                      │                                                                   │
                      │  KnowledgeStore (+projectId, versiones) ◀── ProjectAnalyst (LLM,   │
                      │        ▲  aprobación humana vía API         solo propone)          │
                      │        │                                                          │
 grafo: technicalAnalysisTask ──▶ ContextBuilder ──▶ execution_contexts (congelado) ──▶ prompts
                      └───────────────────────────────────────────────────────────────────┘
```

## 5. Responsabilidades y límites

| Componente | Hace | No hace | ¿LLM? |
|---|---|---|---|
| **ProjectScanner** | Lista los archivos de la raíz validada; clasifica cada archivo (fuente, prueba, configuración, manifiesto, documento, binario, secreto, excluido); calcula hashes incrementales; detecta altas, cambios, bajas y renombrados. | Leer el contenido de secretos o binarios; seguir enlaces simbólicos fuera de la raíz; escribir en el repositorio. | No |
| **Extractors** | Uno por ecosistema, con una interfaz común `detect/extract`. Del manifiesto y la configuración obtienen lenguajes, frameworks y versiones, gestor de paquetes, dependencias directas, scripts, puntos de entrada, raíces de código y pruebas, y configuración de compilación. | Ejecutar scripts o instalar dependencias. | No |
| **ScanScheduler** | Encola y ejecuta escaneos asíncronos; un escaneo por proyecto y un máximo de 2 simultáneos; calcula la firma de frescura; recupera escaneos tras un reinicio. | Escaneos periódicos (fuera de alcance). | No |
| **ContextStore** | Persiste escaneos, índice de archivos y *snapshots* inmutables por proyecto. | Guardar el contenido de los archivos. | — |
| **Knowledge por proyecto** | Documentos `architecture`, `conventions` y `decisions` por proyecto, con versiones inmutables; solo humanos aprueban. | Que un agente apruebe, edite o borre conocimiento aprobado. | — |
| **ProjectAnalyst** | A petición humana, lee el repositorio en solo lectura y **propone** documentos de arquitectura y convenciones, citando archivos reales. | Implementar, modificar código o aprobar conocimiento. | Sí |
| **ContextBuilder** | A partir del proyecto, la HU y el *snapshot*, selecciona fuentes relevantes con un presupuesto de tamaño, redacta posibles secretos y devuelve el contexto con la lista de fuentes. Determinista: la misma entrada da la misma salida. | Decidir por el agente o sustituir la lectura del código. | No |

**Dónde se justifica un LLM:** explicar la arquitectura, inferir las
responsabilidades de los módulos y sus relaciones, detectar convenciones
implícitas y describir flujos. **Todo lo demás es determinista:** estructura,
stack, versiones, dependencias, scripts, puntos de entrada, pruebas, detección
de cambios, frescura y selección de contexto.

## 6. Ubicación de los datos y `.saiki/`

### 6.1. Evaluación de un `.saiki/` dentro de cada repositorio

| Criterio | `.saiki/` en cada repositorio | Datos en el backend (recomendado) |
|---|---|---|
| Colisión de nombre | En Saiki-IA, `.saiki/` ya contiene `core.sqlite`, `checkpoints.sqlite`, etc. | Sin colisión. |
| Modo `sandbox` | Saiki escribiría en el repositorio real fuera del flujo de aprobación. | No toca el repositorio. |
| `git status` del usuario | Aparecen archivos nuevos; hay que tocar el `.gitignore` de cada proyecto. | Limpio. |
| Repositorios de solo lectura o sin permiso de escritura | Fallaría. | Funciona (el registro ya exige escritura solo en modo `real`). |
| Portabilidad del conocimiento | Viaja con el repositorio. | Se pierde si se pierde el directorio de datos; se mitiga con la exportación (§6.3). |
| Exposición a agentes | Los agentes leerían índices generados y posiblemente desactualizados como si fueran código. | No están en el `cwd` de los agentes. |

### 6.2. Estructura definitiva propuesta

Sin archivos nuevos en los repositorios de los usuarios. En el directorio de
datos del backend, que ya está en el `.gitignore`:

```text
.saiki/                       (directorio de datos del backend, gitignored)
├── core.sqlite               + tabla execution_contexts (congelado por ejecución)
├── knowledge.sqlite          + columna projectId y versiones de documentos
├── context.sqlite            NUEVO: context_scans · context_files · context_snapshots
├── checkpoints.sqlite        (sin cambios)
└── events.sqlite             (sin cambios)
```

Se simplifica la propuesta inicial: `structure.json`, `dependencies.json`,
`files.json`, `metadata.json`, `file-hashes.json` y `last-scan.json` son filas
de `context.sqlite`, que da transacciones, recuperación tras un reinicio y
consultas por proyecto sin gestionar ficheros sueltos. `architecture.md`,
`conventions.md` y `decisions.md` son documentos versionados de la Knowledge
Base, con contenido Markdown.

| Dato | Origen | ¿Lo edita una persona? |
|---|---|---|
| `context_scans`, `context_files`, `context_snapshots` | Generado (escáner) | No; se regenera |
| `execution_contexts` | Generado (Context Builder) | No; inmutable |
| Conocimiento `proposed` | Project Analyst o persona | Sí, antes de aprobar |
| Conocimiento `approved` | Persona (aprobación) | No se edita: se crea una versión nueva |

### 6.3. Conservar el conocimiento importante

- El conocimiento aprobado se puede **exportar** como Markdown
  (`GET /projects/:id/knowledge/export`) para que el usuario lo guarde donde
  quiera; por ejemplo, lo versiona en su repositorio por su cuenta o mediante una
  propuesta normal aprobada y aplicada.
- **Fase posterior opcional (D1-b):** sincronizar el conocimiento aprobado con
  una carpeta versionable del repositorio, siempre mediante propuesta → revisión
  → Safe Applier, nunca con escritura directa. La carpeta tendría otro nombre
  (`.saiki-context/`) para no colisionar con el directorio de datos.
- **Documentación que ya existe en el repositorio** (`README*`,
  `ARCHITECTURE*`, `docs/**/*.md`, `CLAUDE.md`, `AGENTS.md`,
  `.kiro/steering/*.md`, `CONTRIBUTING*`) se indexa como fuente de tipo
  `repo-doc`: se usa en el contexto marcada como "del repositorio, no aprobada en
  Saiki". No hace falta duplicarla.

### 6.4. `SAIKI_DATA_DIR` (precisión 1)

- **Resolución:** si `SAIKI_DATA_DIR` está definida, debe ser una ruta absoluta;
  si no, se usa `.saiki` relativo al directorio de arranque del backend, que es el
  comportamiento actual y sigue siendo el valor predeterminado. Todas las bases de
  datos y archivos operativos (`core`, `checkpoints`, `events`, `knowledge`,
  `context`) se derivan de ese único directorio; hoy `serve.ts` repite `.saiki/`
  en cada ruta.
- **Sin migración automática:** si el directorio nuevo no tiene bases de datos y
  el antiguo (`./.saiki`) sí, el arranque avisa con los pasos de migración manual
  (detener el backend, mover los `*.sqlite*` y arrancar) y arranca vacío. Nunca
  mueve, copia ni borra datos.
- **Nunca se escanea ni es alcanzable desde el contexto:** la ruta real del
  directorio de datos se pasa al escáner como exclusión absoluta, de modo que
  nada que esté dentro se lista, esté dentro de un proyecto o no. Además, el
  nombre `.saiki` se excluye en cualquier nivel. El Context Builder rechaza
  cualquier ruta que resuelva dentro del directorio de datos. El registro ya
  impide registrar el directorio de datos como proyecto.
- **Documentación:** cómo cambiar la ubicación, en `docs/API.md` (variables de
  entorno) y en `README.md`.
- **Tareas:** la exclusión ya entra en T1; la variable y el aviso de migración,
  en T4b.

## 7. Modelo de datos

### 7.1. `context.sqlite`

```sql
context_scans(
  id TEXT PK, projectId TEXT, mode TEXT CHECK (mode IN ('full','incremental')),
  status TEXT CHECK (status IN ('queued','running','completed','failed','interrupted')),
  trigger TEXT,             -- registered | manual | stale_check | post_apply | restart
  startedAt, finishedAt, rootPath, fingerprint JSON, gitHead TEXT NULL,
  signature TEXT,           -- firma de frescura al empezar (§8.3)
  stats JSON,               -- {listed, hashed, added, modified, deleted, renamed, skipped, truncated}
  error TEXT NULL)

context_files(
  projectId, path,          -- ruta relativa POSIX
  kind TEXT,                -- source|test|config|manifest|doc|binary|secret|other
  lang TEXT NULL, size INTEGER, mtimeMs INTEGER,
  hash TEXT NULL,           -- sha256; NULL para secretos y binarios grandes
  lastScanId TEXT,
  PRIMARY KEY (projectId, path))

context_snapshots(          -- solo inserción (trigger), inmutable
  id TEXT PK, projectId, scanId, createdAt,
  indexHash TEXT,           -- hash del conjunto (path, hash) incluido
  summary JSON)             -- stack, deps, scripts, entryPoints, modules, configs, tests, repoDocs
```

`summary` (forma estable, versionada con `schemaVersion`):

```json
{
  "schemaVersion": 1,
  "languages": [{ "lang": "typescript", "files": 210 }],
  "ecosystems": [{
    "kind": "node", "manifest": "package.json", "packageManager": "npm",
    "frameworks": [{ "name": "angular", "version": "17.3.0", "source": "package-lock.json" }],
    "dependencies": [{ "name": "rxjs", "range": "~7.8.0", "dev": false }],
    "scripts": { "test": "ng test" },
    "entryPoints": ["src/main.ts"], "sourceRoots": ["src"], "testPatterns": ["**/*.spec.ts"]
  }],
  "modules": [{ "path": "src/app/auth", "files": 14, "tests": 3 }],
  "configFiles": ["angular.json", "tsconfig.json", "capacitor.config.ts"],
  "tests": { "files": 48, "frameworks": ["jasmine"] },
  "repoDocs": [{ "path": "README.md", "hash": "…" }],
  "truncated": false
}
```

### 7.2. `knowledge.sqlite` (cambio aditivo)

- Columna `projectId TEXT NULL`: `NULL` es el conocimiento global actual, que no
  cambia.
- Columnas `version INTEGER` y `basedOn TEXT NULL` (documento del que deriva).
- **Regla nueva:** un documento `approved` no se puede editar con `update()`;
  para cambiarlo se crea una versión nueva `proposed` con `basedOn` y, al
  aprobarla, la anterior pasa a `superseded`. Las decisiones aprobadas nunca se
  pierden (caso 8).
- La categoría `decisions` es de solo adición para los agentes: el Project
  Analyst puede proponer decisiones nuevas, pero nunca versiones de una decisión
  aprobada.

### 7.3. `core.sqlite`: `execution_contexts` (solo inserción, como `execution_projects`)

```sql
execution_contexts(
  executionId, huVersion INTEGER,
  projectId, snapshotId,         -- snapshotId fijo para toda la ejecución
  builtAt, stale INTEGER,        -- 1 si se usó un snapshot desactualizado
  sources JSON,                  -- [{kind:'index'|'knowledge'|'repo-doc', ref, version|hash}]
  bundleHash TEXT, bundle TEXT,  -- texto exacto enviado a los agentes
  PRIMARY KEY (executionId, huVersion))
```

**Trazabilidad (precisión 3).** Cada fila de `execution_contexts` conserva:

- `snapshotId` e `indexHash` del *snapshot* usado;
- en `sources`:
  - los documentos de conocimiento aprobados (`docId` + `version`);
  - la documentación del repositorio consultada (`path` + `hash`);
  - los archivos y rutas seleccionados como relevantes, con su puntuación;
  - el historial de ejecuciones usado, cuando exista (§9.4);
- `builtAt`, `stale`, `bundleHash` y el `bundle` literal.

Con el `bundle` literal y el `bundleHash` se puede reconstruir exactamente qué
recibió cada agente en cualquier ejecución anterior. La tabla es de solo
inserción.

Estado del grafo: un campo nuevo `contextSnapshotId`, *keep-first* como
`project`. El contexto completo no va al *checkpoint* para no inflarlo; se
guarda en la tabla y el estado solo guarda la referencia.

## 8. Escaneo inicial e incremental

### 8.1. Listado de archivos

1. Comprobar que el proyecto está activo, con salud `ok` y huella igual a la del
   registro; si no, el escaneo falla con `project_unhealthy` o
   `project_identity_changed`.
2. Listar con `git -c core.quotepath=off ls-files -z --cached --others
   --exclude-standard`, mediante `spawnProcessRunner` con `cwd` = raíz, tiempo
   límite y límite de salida, y **con `GIT_DIR`, `GIT_WORK_TREE` y
   `GIT_INDEX_FILE` eliminados del entorno**. Respeta el `.gitignore` del
   proyecto exactamente y no ejecuta *hooks*. Todos los proyectos registrados son
   repositorios Git (D1 del registro).
3. **Alternativa sin Git** (si `git` falla o no está instalado): recorrido propio
   con `lstat` y las exclusiones fijas. Las exclusiones fijas se aplican siempre,
   también sobre la salida de Git.
4. Exclusiones fijas: `.git`, `.saiki`, `.saiki-context`, `node_modules`, `dist`,
   `build`, `out`, `.next`, `.nuxt`, `.angular`, `.turbo`, `.dart_tool`, `.gradle`,
   `.idea`, `.vscode`, `coverage`, `Pods`, `www` (salida de Ionic), `.cache`,
   `tmp`, `*.log`, `.DS_Store`. Se reutiliza y amplía `SANDBOX_EXCLUDED`.
5. **Secretos (solo se registra el nombre; el contenido nunca se lee, ni se
   calcula su hash):** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
   `*.keystore`, `*.jks`, `id_rsa*`, `*.mobileprovision`, `google-services.json`,
   `GoogleService-Info.plist`, `credentials*`, `secrets*`, `.npmrc` con
   `_authToken`.
6. **Binarios:** por extensión conocida o por un byte NUL en los primeros 8 KB;
   se registran tamaño y hash, sin contenido.
7. **Enlaces simbólicos:** se registran, pero no se siguen; si apuntan fuera de
   la raíz (`isWithin`), se marcan como excluidos.
8. Submódulos y repositorios anidados: se listan como una entrada y no se
   recorren (limitación documentada).

### 8.2. Detección de cambios (no depende solo de Git)

Para cada ruta listada, se compara con `context_files`:

- **nueva** → se calcula el hash;
- **(size, mtimeMs) distinto** → se recalcula el hash; si el hash no cambia, solo
  se actualiza el `stat`;
- **(size, mtimeMs) igual** → se reutiliza el hash anterior;
- **ausente** → baja;
- **baja + alta con el mismo hash** → renombrado (caso 4).

Un manifiesto modificado (`package.json`, `package-lock.json`, `pubspec.yaml`,
`pubspec.lock`, `angular.json`, etc.) vuelve a ejecutar **solo su extractor**
(caso 3). El resumen se recalcula agregando desde `context_files` y la salida de
los extractores, cacheada por hash de manifiesto, que es barato. Las escrituras
se hacen en lotes de unos 500 archivos por transacción.

**Escaneo completo (`mode: full`):** recalcula todos los hashes sin fiarse del
`stat`. Sirve para el primer escaneo, si se sospecha de ediciones con el mismo
tamaño y la misma fecha de modificación, o a petición del usuario.

### 8.3. Frescura

La **firma** es el hash de: `git rev-parse HEAD`, más la salida de
`git status --porcelain=v1 -z`, más el `(size, mtimeMs)` de los manifiestos de la
raíz. Si coincide con la del último escaneo completado, el contexto está **al
día**; si no, está **desactualizado** (con el número aproximado de rutas en
`git status`). Si Git no está disponible, se hace una pasada de solo `stat`.
Comprobarla cuesta milisegundos y se hace al pedir el estado, al empezar el
análisis técnico y tras aplicar en modo `real`.

### 8.4. Asincronía, concurrencia y reinicio

- Los escaneos corren en el proceso del backend como tareas asíncronas, con E/S
  asíncrona, hash por *streaming* y cesión del bucle de eventos entre lotes. La
  API responde `202` y Jev sigue el progreso por SSE.
- Un escaneo por proyecto: si se pide otro mientras hay uno en curso, se devuelve
  el que está en curso. Máximo 2 proyectos a la vez; el resto queda `queued`
  (caso 6).
- **Reinicio (caso 5):** al arrancar, los escaneos `running` o `queued` pasan a
  `interrupted` (mismo patrón que `activeRuns`) y se reencolan una vez como
  incrementales. Como las filas ya escritas conservan sus hashes, el nuevo escaneo
  retoma el trabajo sin repetirlo. **El *snapshot* solo se crea al completar el
  escaneo**, de forma atómica, así que nunca se usa un índice a medias.
- Límites por defecto, configurables: 50 000 archivos indexados (si se superan,
  `truncated: true`, avisado en la UI y en el contexto); los archivos de más de
  20 MB se registran sin hash; tiempo máximo de un escaneo, 10 minutos.
- **Repositorios grandes (caso 10):** el listado lo resuelve Git (rápido), solo
  se recalcula el hash de lo que cambió, los extractores solo se ejecutan cuando
  cambia su manifiesto, y el contexto nunca envía el árbol completo, sino un
  resumen por módulos y una lista acotada de archivos.

## 9. Integración con los agentes y el flujo

### 9.1. Punto de integración

Dentro de `technicalAnalysisTask`, sin nodos nuevos en el grafo para no alterar
la topología ni los *checkpoints* existentes:

1. Si la ejecución aún no tiene `contextSnapshotId`: comprobar la frescura; si el
   contexto está desactualizado, lanzar un escaneo incremental y esperar como
   máximo `SAIKI_CONTEXT_REFRESH_MS` (30 s por defecto). Después se **fija** el
   último *snapshot* completado (*keep-first*).
2. `ContextBuilder.build({ project, snapshotId, hu })` devuelve el contexto y sus
   fuentes, que se guardan en `execution_contexts` para la versión de la HU.
3. El contexto se añade al *prompt* técnico como una sección delimitada:
   "Contexto del proyecto (orientativo; verifica en el código antes de
   afirmar)".
4. `developTask` recibe un subconjunto del mismo contexto (convenciones
   aprobadas y comandos de pruebas y compilación) a través de `DevContext`.
5. **Revisores:** el revisor de calidad recibe las convenciones aprobadas. Se
   deja para una tarea posterior (T13), no para el primer corte.

La HU, la viabilidad, las aprobaciones y el Safe Applier no cambian.

### 9.2. Selección determinista (Context Builder)

1. **Siempre:** el resumen del stack (lenguajes, frameworks y versiones, gestor
   de paquetes, scripts de pruebas y compilación, puntos de entrada) y el
   conocimiento `approved` del proyecto, primero las convenciones.
2. **Por relevancia:** términos de la HU (resumen, necesidad, tareas, criterios),
   normalizados y separando camelCase, kebab-case y snake_case, comparados con
   segmentos de ruta y nombres de módulo. Puntuación = coincidencias ponderadas
   (nombre de archivo > directorio > extensión); se añaden las pruebas emparejadas
   (`x.ts` ↔ `x.spec.ts` / `x_test.dart`).
3. **Documentación del repositorio:** fragmentos de los `repo-doc` cuya ruta o
   encabezados coincidan con los términos.
4. **Presupuesto:** unos 12 000 caracteres por defecto; como mucho 25 archivos
   relevantes y 2 documentos de conocimiento completos (el resto, solo el
   título). Se recorta por prioridad.
5. **Redacción:** antes de enviarlo, el texto pasa por los patrones de *tokens*
   conocidos (GitHub, Anthropic, AWS, Slack, Google y claves privadas).
6. **Salida:** el contexto en texto más `sources[]` con tipo, referencia y versión
   o hash. Se ve en Jev como "Contexto usado".

No se envían contenidos de archivos de código: solo rutas, metadatos, resumen y
conocimiento. Los agentes leen el código ellos mismos. Esto mantiene el contexto
pequeño y el código como fuente de verdad.

### 9.3. Project Analyst

- Es un rol nuevo `projectAnalyst` en el `AgentRouter`; por defecto, Kiro con
  `fs_read`, en solo lectura y con `cwd` = raíz del proyecto. Es independiente
  del proveedor porque el rol se puede reasignar.
- **Solo se activa a petición humana** (`POST /projects/:id/analysis`); no corre
  automáticamente, para controlar el coste.
- Entrada: el resumen del *snapshot*, el conocimiento aprobado vigente y la lista
  de `repo-doc`.
- Salida en JSON: `{ documents: [{ category, title, content, citedFiles[] }] }`.
  Se valida contra un esquema; cada archivo citado debe existir (reutiliza la
  verificación de rutas); si hay un documento aprobado de la misma categoría, la
  propuesta se crea con `basedOn`.
- Resultado: documentos `proposed` del proyecto. Una persona los revisa y los
  aprueba o rechaza en Jev, que muestra la diferencia con la versión aprobada.

### 9.4. Continuidad del desarrollo (precisión 2; no se implementa ahora)

Cada solicitud de una sesión crea una ejecución nueva, independiente e
inmutable, ligada a la misma sesión y al mismo proyecto. Así funciona ya hoy, y
el diseño lo conserva. Para que el Context Builder pueda usar más adelante las
ejecuciones anteriores (propuestas aplicadas, archivos modificados, análisis y
decisiones), sin cerrar esa puerta:

- Las fuentes del contexto tienen un tipo `execution-history`, reservado:
  `ref` = `executionId`, versión = `appliedHash` o `finalApprovedHash`.
- El Context Builder recibe sus entradas a través de proveedores (índice,
  conocimiento, documentación del repositorio). El historial será un proveedor
  más, que leerá datos ya persistidos y no requiere cambiar el esquema actual:
  `appliedFiles`, `auditRecord`, `technicalAnalysis` y `decisions` en el
  estado; `execution_projects` y `execution_contexts` en `core.sqlite`.
- Los *snapshots* que alguna ejecución haya usado no se borran nunca.
- No se guarda nada a nivel de sesión que una ejecución posterior pueda
  sobrescribir.

## 10. Contratos API (todos aditivos)

| Método y ruta | Respuesta |
|---|---|
| `GET /projects/:id/context` | `{ context: { status: "none"\|"scanning"\|"ready"\|"stale"\|"failed", snapshot?: {id, createdAt, summary}, currentScan?: {id, status, stats}, stale?: {reason, changedPaths} } }` |
| `POST /projects/:id/context/scan` `{ mode?: "incremental"\|"full" }` | `202 { scan }`; si ya hay uno en curso, devuelve ese. `409 project_inactive` / `project_unhealthy`. |
| `GET /projects/:id/context/scans?limit=` | `{ scans: [...] }` |
| `GET /projects/:id/context/files?prefix=&kind=&cursor=&limit=` | Índice paginado `{ files, nextCursor }` |
| `GET /knowledge?projectId=` | Filtro nuevo sobre el endpoint existente. |
| `POST /projects/:id/knowledge` `{ category, title, content, basedOn? }` | `201 { document }` en estado `proposed` (autor humano). |
| `POST /knowledge/:id/approve` · `POST /knowledge/:id/reject` | La acción queda a nombre de la identidad humana local configurada; los agentes no tienen acceso a la API. |
| `GET /projects/:id/knowledge/export` | Conocimiento aprobado en Markdown. |
| `POST /projects/:id/analysis` · `GET /projects/:id/analysis/:jobId` | Lanza el Project Analyst (`202`) y consulta su estado. |
| `GET /executions/:id` | Campo nuevo `context: { snapshotId, builtAt, stale, sources }`. |

Eventos SSE nuevos (`docs/EVENTS.md`): `context.scan.queued`,
`context.scan.started`, `context.scan.progress` (como mucho uno cada 2 s),
`context.scan.completed`, `context.scan.failed`, `context.scan.interrupted`,
`context.stale` y `knowledge.approved`. Todos llevan `projectId`.

## 11. Cambios en el frontend

- **Proyectos:** cada proyecto muestra el estado del contexto (Sin escanear /
  Escaneando N archivos / Al día / Desactualizado, N cambios / Falló, con el
  motivo) y los botones "Actualizar contexto" y "Escaneo completo".
- **Página nueva `/projects/:id`:** Resumen (stack, dependencias, scripts,
  módulos, pruebas), Archivos (índice paginado con filtro), Conocimiento
  (aprobado + propuestas con diferencias, aprobar o rechazar, botón "Proponer
  documentación"), Escaneos (historial).
- **Ejecución:** panel "Contexto usado" con la fecha del *snapshot*, el aviso de
  desactualizado y las fuentes con su versión.
- **Conocimiento:** filtro por proyecto.
- Todo mediante la API y SSE, sin datos simulados y con el stack aprobado.

## 12. Seguridad y aislamiento

- Todas las filas y consultas llevan `projectId`. El Context Builder toma el
  proyecto de la **vinculación de la ejecución**, nunca del texto de la
  solicitud.
- El escáner es de solo lectura, valida la identidad antes y después, no sigue
  enlaces simbólicos fuera de la raíz, no lee secretos y no guarda el contenido
  de los archivos.
- `git` se ejecuta sin variables `GIT_*` heredadas, con tiempo límite y límite de
  salida, y sin *hooks* (`ls-files`, `status` y `rev-parse` no los ejecutan).
- Los agentes no reciben acceso de escritura a nada nuevo. El Project Analyst
  solo produce documentos `proposed`. `approve()` sigue rechazando actores de
  agente, y aprobar solo es posible por la API, que los agentes no usan.
- `.saiki/` sigue en `PROTECTED_DIRS`.
- **Riesgo residual:** en el proyecto Saiki-IA, el directorio de datos está
  dentro de su raíz, así que un agente con `fs_read` podría leer las bases de
  datos. El escáner lo excluye. Mitigación futura opcional: mover el directorio
  de datos fuera del repositorio (`SAIKI_DATA_DIR`).
- Se mantiene documentado el riesgo, ya existente, de que Kiro lea fuera del
  proyecto.

### 12.1. Niveles de confianza (precisión 4)

| Nivel | Fuente | Cómo se marca en el contexto |
|---|---|---|
| `index` | Índice técnico determinista | "Generado del repositorio" |
| `knowledge` | Conocimiento aprobado por una persona (solo `approved`; lo `proposed` nunca entra en el contexto) | "Aprobado en Saiki, versión N" |
| `repo-doc` | Documentación existente del repositorio | "Del repositorio, no aprobado en Saiki" |
| `execution-history` | Ejecuciones anteriores (futuro, §9.4) | "Historial de la ejecución X" |

**Nada se promueve automáticamente.** El tipo de fuente es un valor cerrado que
el código asigna según de dónde se lee, nunca según el contenido. Un `repo-doc`
o una salida del Project Analyst solo llegan a `knowledge` si una persona crea o
revisa una propuesta y la aprueba por la API (`approve()` rechaza actores de
agente).

## 13. Casos de uso

| # | Caso | Solución |
|---|---|---|
| 1 | Registrar un proyecto y generar su primer contexto | Al registrarse, se encola un escaneo `full` (`trigger: registered`); Jev muestra el progreso; el *snapshot* inicial se crea al terminar. |
| 2 | Cambios hechos fuera de Saiki | La firma de frescura los detecta; el estado pasa a `stale`; el escaneo incremental solo recalcula el hash de lo que cambió. |
| 3 | Dependencia nueva | El hash del manifiesto cambia; se ejecuta solo ese extractor; el *snapshot* nuevo refleja la dependencia. |
| 4 | Módulo eliminado o renombrado | Altas y bajas por ruta; renombrado = baja + alta con el mismo hash; el resumen de módulos se recalcula. |
| 5 | Reinicio durante un escaneo | El escaneo pasa a `interrupted` y se reencola; los hashes ya calculados se reutilizan; nunca hay un *snapshot* parcial. |
| 6 | Dos proyectos a la vez | Un bloqueo por proyecto y un máximo de 2 simultáneos; filas separadas por `projectId`. |
| 7 | Solicitud con contexto desactualizado | Refresco incremental de 30 s como máximo; si no termina, se usa el último *snapshot* con `stale: true`, avisado al agente y en Jev. Nunca bloquea. |
| 8 | Actualizar arquitectura sin perder decisiones | Las versiones aprobadas son inmutables y los cambios llegan como versiones nuevas; las decisiones son de solo adición para los agentes. |
| 9 | El repositorio cambia durante una ejecución | `contextSnapshotId` *keep-first* y `execution_contexts` inmutable; al reanudar se usa el mismo *snapshot*. Si cambia la identidad del repositorio, el registro ya bloquea la aplicación. |
| 10 | Repositorio muy grande | Listado con Git, hash incremental, límite de archivos con aviso `truncated`, contexto acotado. |

## 14. Riesgos y casos límite

- **Contexto desactualizado que confunde a los agentes:** se marca como
  orientativo, con la regla de verificar en el código; la verificación de rutas y
  la viabilidad no dependen del contexto.
- **Selección por palabras clave imprecisa:** es un riesgo aceptado en esta fase.
  Se mide en la validación real (¿cita el análisis archivos que estaban en el
  contexto?) antes de plantear búsqueda semántica.
- **Ediciones con el mismo tamaño y la misma fecha de modificación:** las detecta
  la firma de Git si el archivo está versionado; el escaneo `full` lo resuelve en
  cualquier caso.
- **Renombrados que solo cambian mayúsculas en macOS:** se normaliza y se prueba
  de forma explícita.
- **Secretos dentro de archivos de código normales:** no se envía su contenido;
  los `repo-doc` y los scripts pasan por la redacción.
- **Crecimiento de `events.sqlite`:** los eventos de progreso se limitan; no hay
  eventos por archivo.
- **Compatibilidad:**
  - Las ejecuciones pausadas antes de la fase siguen funcionando: si aún no
    llegaron al análisis técnico, reciben contexto al llegar.
  - Si ya lo pasaron, se muestran como "sin contexto".
  - Las ejecuciones antiguas sin proyecto no reciben contexto.
  - La Knowledge Base global (`projectId NULL`) no cambia.
- **Monorepos y submódulos:** varios manifiestos se resuelven con un ecosistema
  por manifiesto; los submódulos no se recorren.
- **`pubspec.yaml` sin parser YAML:** un parser mínimo propio para
  `dependencies`/`dev_dependencies`/`environment` (ver D7), con pruebas sobre
  casos reales.

## 15. Decisiones que necesito

| # | Decisión | Recomendación |
|---|---|---|
| D1 | Dónde guardar el índice y el conocimiento | **Directorio de datos del backend (SQLite); nada en los repositorios.** La sincronización opcional con `.saiki-context/` mediante propuesta queda para el futuro. |
| D2 | Conocimiento por proyecto | **Ampliar la Knowledge Base existente** con `projectId` y versiones inmutables de lo aprobado, en vez de crear otro almacén. |
| D3 | Solicitud con contexto desactualizado | **Refresco incremental con un límite de 30 s y, si no termina, *snapshot* anterior marcado como desactualizado.** Nunca bloquear. |
| D4 | Listado de archivos | **`git ls-files` y exclusiones propias**, con recorrido propio si Git no está disponible. Detección de cambios por `stat` y hash, no solo por Git. |
| D5 | Activación del Project Analyst | **Solo manual**, desde Jev. |
| D6 | Agente del Project Analyst | **Kiro con `fs_read`** (como el analista técnico), reasignable por rol. |
| D7 | Leer `pubspec.yaml` | **Parser mínimo propio** (sin dependencias nuevas). La alternativa es añadir la dependencia `yaml`. |
| D8 | Documentación existente del repositorio | **Usarla como fuente `repo-doc`**, marcada como no aprobada en Saiki. |
| D9 | Escaneo interrumpido por un reinicio | **Reencolarlo una vez al arrancar.** |
| D10 | Límites por defecto | 50 000 archivos, 2 escaneos simultáneos, contexto de unos 12 000 caracteres, 30 s de refresco. |

## 16. Plan de implementación

Cada tarea se entrega con pruebas, typecheck y la suite en verde antes de pasar a
la siguiente. Las tareas T1–T9 dan valor sin LLM; T10 y T11 añaden el
conocimiento asistido.

| # | Tarea | Verificación |
|---|---|---|
| T1 | `ProjectScanner`: listado con Git y alternativa propia, exclusiones, clasificación (secreto, binario, enlace simbólico) y entorno de Git saneado. | Unitarias con `TempRepos`: `.gitignore` respetado, secretos sin contenido ni hash, enlaces simbólicos fuera de la raíz excluidos, `GIT_DIR` hostil ignorado, directorio de datos excluido, identidad comprobada antes y después, repositorio (incluido `.git`) intacto tras escanear. Ejecución sobre repositorios reales. |
| T2 | `ContextStore` (`context.sqlite`): tablas, *trigger* de inmutabilidad de *snapshots*, consultas por proyecto. | Unitarias: aislamiento entre dos proyectos; un *snapshot* no se puede actualizar ni borrar. |
| T3 | Motor incremental: diferencias (alta, cambio, baja, renombrado), hash por *streaming*, lotes, estados del escaneo, recuperación al arrancar. | Unitarias: cada tipo de cambio; renombrado; interrupción a mitad simulada y reanudación sin repetir hashes; nunca hay un *snapshot* parcial. |
| T4 | Extractores: Node (npm/pnpm/yarn), Angular, Ionic/Capacitor, Flutter (parser mínimo de `pubspec`) y genérico (lenguajes, pruebas, configuración, puntos de entrada); resumen del *snapshot*. | Fixtures por stack con resultado esperado; manifiesto inválido → aviso, sin fallo. |
| T4b | `SAIKI_DATA_DIR` (§6.4): resolución de la ruta, rutas derivadas en `serve.ts`, aviso de migración sin mover nada, documentación. | Unitarias: valor predeterminado igual al actual; ruta relativa → error; aviso si los datos están en la ubicación antigua; ningún archivo movido. |
| T5 | `ScanScheduler` en `SaikiCore` + fachada `JevContextPort`: escaneo al registrar, manual y tras aplicar en modo `real`; firma de frescura; concurrencia. | Integración: dos proyectos en paralelo; un segundo escaneo del mismo proyecto devuelve el que está en curso; proyecto desactivado o movido → escaneo rechazado. |
| T6 | API y SSE de contexto (§10, primeras 4 filas) + `docs/API.md` y `docs/EVENTS.md`. | Pruebas HTTP y SSE; errores `409`. |
| T7 | Context Builder: relevancia, presupuesto, redacción, fuentes. | Unitarias de referencia (*golden*): el mismo *snapshot* y la misma HU dan exactamente el mismo contexto; presupuesto respetado; *token* falso redactado. |
| T8 | Integración en el grafo: `contextSnapshotId` *keep-first*, `execution_contexts`, *prompts* técnico y de desarrollo, política de D3. | Integración con `FlowAgent`: el *prompt* contiene el contexto; el caso 9 congela el *snapshot* aunque cambie el repositorio; las ejecuciones antiguas siguen funcionando; refresco con tiempo agotado → `stale`. |
| T9 | Frontend I: estado del contexto en Proyectos, página `/projects/:id` (Resumen, Archivos, Escaneos), "Contexto usado" en la ejecución. | Vitest del modelo; AccessLint sin violaciones. |
| T10 | Conocimiento por proyecto: `projectId`, versiones, aprobado inmutable, endpoints de crear, aprobar, rechazar y exportar. | Unitarias: un agente no puede aprobar; editar un aprobado → error; una versión nueva reemplaza a la anterior sin perderla; la Knowledge Base global sigue igual. |
| T11 | Project Analyst: rol, instrucciones, esquema, validación de las rutas citadas, trabajo manual; Frontend II (pestaña Conocimiento con diferencias y aprobación). | Con agente simulado: solo produce `proposed`; una ruta citada inexistente → rechazo; `cwd` = raíz del proyecto. |
| T12 | Validación final real y documentación (`ARCHITECTURE.md`, `PROJECT_MEMORY.md` fase 23). | §17. |
| T13 | (Posterior) Convenciones aprobadas para el revisor de calidad. | Se decide tras evaluar T12. |

## 17. Pruebas

**Unitarias:** escáner (exclusiones, secretos, binarios, enlaces simbólicos,
Git hostil, alternativa sin Git), motor incremental (cada tipo de cambio,
renombrado con mayúsculas, ediciones con el mismo `stat` y escaneo `full`),
extractores por stack, firma de frescura, Context Builder (determinismo,
presupuesto, redacción, fuentes), reglas de versiones de la Knowledge Base,
esquema del Project Analyst.

**Integración:** API y SSE de contexto; programador con dos proyectos;
reinicio a mitad de escaneo (cerrar `SaikiCore` y abrir uno nuevo sobre los
mismos datos); grafo con contexto (análisis técnico y desarrollo); caso 9
(modificar el repositorio entre etapas); aislamiento (el contexto del proyecto B
nunca aparece en una ejecución de A); compatibilidad de los *checkpoints*
anteriores.

**End-to-end (validación real, como en la fase 22):**

- Tres repositorios reales: Node (`calc-node`), Flutter (`notes-flutter`) y un
  Angular/Ionic mínimo.
- Escaneo inicial desde Jev y dos escaneos simultáneos.
- Modificaciones, dependencia nueva y renombrado hechos fuera de Saiki.
- Reinicio del backend durante un escaneo.
- Solicitud con contexto desactualizado, con Kiro y Claude reales y "Contexto
  usado" visible.
- Project Analyst real que propone y una persona que aprueba.
- Un repositorio sintético de unos 30 000 archivos con tiempos medidos.
- Hashes de los repositorios intactos (el escáner no escribe).
- Suite completa, typecheck y AccessLint.

## 18. Fuera de alcance

RAG, embeddings, bases vectoriales, búsqueda semántica, escaneos periódicos o
vigilancia del sistema de archivos (`fs.watch`), un agente que modifique código,
escritura automática en los repositorios de los usuarios e implementación de
funcionalidades de usuario.
