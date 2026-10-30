# Project Registry: diagnóstico y diseño

> **Estado: aprobado (D1–D9 según las recomendaciones) e implementado el
> 2026-10-30.** Resultado, verificación y limitaciones: `docs/PROJECT_MEMORY.md`
> §3.23. Diferencias con este diseño: (1) también el moderador corre en un
> directorio vacío, no solo la asistencia (detectado en la prueba real); (2) se
> añadió `ExecutionView.applyTarget` y `project.current.applyMode`; (3) el modo
> real exige que lo sea al vincular Y en el momento de aplicar; (4) ninguna
> propuesta puede tocar `.git/` ni `.saiki/`; (5) D9 no pudo registrar Saiki-IA
> porque su directorio no es un repositorio git.
>
> Fecha del diseño: 2026-10-30. Base: estado del código tras la mini-fase de
> estabilización (`docs/PROJECT_MEMORY.md` §3.22).

## 1. Resumen ejecutivo

Hoy Saiki-IA trabaja sobre **un único repositorio implícito**: el directorio
desde el que se arranca el backend. No es una opción de configuración por
ejecución, sino una constante repartida en varios sitios:

- el grafo se construye una vez con `rootDir` y `applyDir` como closures de sus
  nodos (`src/hu/hu-graph.ts:766-784`);
- los agentes se lanzan sin `cwd` (`src/agents/process-runner.ts:70`): Kiro y
  Claude leen el directorio del backend, no el del proyecto;
- la "copia temporal" de aplicación copia solo `src/`, una vez al arrancar, y la
  comparten todas las ejecuciones (`src/api/serve.ts:61-65`).

La propuesta añade un registro de proyectos en SQLite y **ata cada ejecución, al
nacer, a una copia inmutable de su proyecto** (identidad, ruta real y huella del
repositorio). Esa copia viaja en el estado del grafo, que ya es persistente, y se
duplica en una tabla de solo inserción. Los nodos leen la ruta del estado de la
ejecución en lugar de una constante, los agentes se lanzan con `cwd` del proyecto,
y antes de aplicar el Safe Applier revalida proyecto, ruta y huella. Todo es
aditivo; las sesiones y ejecuciones existentes siguen funcionando.

Decisiones que necesito: §11.

## 2. Arquitectura actual (verificada en el código)

| Pieza | Comportamiento hoy | Dónde |
|---|---|---|
| Sesión | `ModeratorSession` en `core.sqlite` como JSON (`core_sessions`). Sin proyecto. `POST /sessions` no persiste: solo reserva un id. | `src/core/core-store.ts`, `src/api/http-server.ts` (`POST /sessions`) |
| Ejecución | Un hilo de LangGraph por solicitud de desarrollo (`dev-<uuid>`); la sesión guarda `developmentThreadIds`. Estado en el checkpointer SQLite. | `src/core/saiki-core.ts` (`process`, `runGraph`) |
| Grafo | Un único grafo compilado en el constructor de `SaikiCore`. `rootDir` (lectura) y `applyDir` (escritura) fijos por closure. | `src/hu/hu-graph.ts:726-784` |
| Análisis técnico | Recibe `rootDir` en el prompt ("código del proyecto en: …") y valida rutas en disco contra `rootDir`. | `src/tech/tech-instructions.ts:15`, `src/tech/tech-analyst.ts:55` |
| Desarrollo | Valida la propuesta contra `rootDir` (archivos nuevos o existentes). | `src/dev/dev-schema.ts:131` |
| Revisores | Kiro con `--trust-tools=fs_read`; **no reciben ruta**: leen desde el `cwd` del proceso. | `src/reviewers/reviewers.ts`, `src/agents/kiro-cli-agent.ts:76` |
| Lanzamiento de agentes | `spawn(command, args, { shell: false })` sin `cwd`: heredan el directorio del backend. | `src/agents/process-runner.ts:70` |
| Safe Applier | `applyTask` recalcula el hash y lo compara con lo aprobado; escribe solo dentro de `applyDir` (`resolveSafePath`: anti absoluta, traversal y symlink por archivo); detecta conflictos con hashes base; rollback best-effort; `verifyTask` compara disco y propuesta. | `src/hu/hu-graph.ts:454-575`, `src/apply/*` |
| Modo de aplicación | Global: copia temporal de `src/` creada al arrancar, o repo real con `SAIKI_APPLY_TO_REAL_REPO=1`. | `src/api/serve.ts:59-66` |
| Asistencia (OpenCode) | Tarea de solo lectura; también sin `cwd`. | `src/moderator/delegation-runner.ts`, `src/agents/opencode-cli-agent.ts` |
| Historial | `proposal_versions` y `human_decisions` (solo inserción, triggers). | `src/core/core-store.ts` |

Problemas previos que afectan a esta fase (no son nuevos, pero con varios
proyectos dejan de ser aceptables):

1. **Agentes sin `cwd`**: los revisores analizan el repositorio del backend aunque
   la ejecución sea de otro proyecto.
2. **Copia temporal incompleta y compartida**: solo `src/` y una para todas las
   ejecuciones.
3. **Ruta fija en el grafo**: dos proyectos a la vez son imposibles sin cambiarla.

## 3. Qué se reutiliza

- `CoreStore` (SQLite, mismo archivo `core.sqlite`) y su patrón de tablas de solo
  inserción con triggers (ya probado en la estabilización).
- `resolveSafePath`, hashes base, idempotencia y rollback del Safe Applier: no
  cambian; solo cambia de dónde sale la raíz.
- El estado del grafo (`HuState`) y el checkpointer como fuente persistente de la
  identidad de la ejecución, igual que `devProposalHash`.
- El hook opcional del grafo (como `runChecks`) para inyectar la validación del
  proyecto en `applyTask` sin que el grafo dependa de `CoreStore`.
- `runGraph` como único punto de entrada: es donde se fija la vinculación.
- El campo libre `AgentRequest.context` para pasar el directorio de trabajo a los
  adaptadores, sin cambiar el contrato `AgentAdapter`.

## 4. Modelo de datos

### 4.1. Proyecto (`projects`, en `core.sqlite`)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | `prj-<uuid>`, generado por el backend |
| `name` | TEXT | Único entre proyectos activos; editable |
| `rootPath` | TEXT | Ruta **real** (`realpath`), absoluta. Inmutable (ver D2) |
| `status` | TEXT | `active` \| `inactive` |
| `applyMode` | TEXT | `sandbox` \| `real` (ver D4) |
| `fingerprint` | TEXT (JSON) | `{ dev, ino, gitDir }` del directorio raíz al registrar |
| `createdAt`, `updatedAt` | TEXT | ISO |
| `deactivatedAt` | TEXT \| null | |

Restricciones: un mismo `rootPath` no puede estar activo dos veces. No hay borrado
físico (solo desactivación) para no romper la trazabilidad histórica.

### 4.2. Vinculación ejecución → proyecto (`execution_projects`, solo inserción)

| Campo | Notas |
|---|---|
| `executionId` | PK |
| `projectId`, `projectName` | Copia en el momento de empezar |
| `rootPath` | Ruta real usada al empezar |
| `applyMode` | Modo de aplicación vigente al empezar |
| `fingerprint` | Huella vigente al empezar |
| `boundAt` | ISO |

Triggers contra `UPDATE` y `DELETE`, igual que el historial de propuestas.

La misma copia se escribe en el estado del grafo (campo nuevo `project`, con un
reducer que **conserva el primer valor**: una vez fijado, ningún nodo ni
reanudación puede cambiarlo). Dos fuentes independientes de la misma verdad, que el
Safe Applier compara antes de escribir.

### 4.3. Sesión

`ModeratorSession.projectId?: string` (aditivo, dentro del JSON actual). Se fija al
crear la sesión y no cambia. Sin `projectId` = sesión general.

### 4.4. Relaciones

```
Project 1 ── n Session (projectId, fijo desde la creación; opcional)
Session 1 ── n Execution (developmentThreadIds)
Execution 1 ── 1 ExecutionProject (copia inmutable al empezar)
```

Una ejecución hereda el proyecto **de su propia sesión** en el momento en que nace;
nunca de otra sesión ni de un valor global.

### 4.5. Historial de cambios del registro (opcional, ver D7)

`project_history` (solo inserción): `registered`, `renamed`, `deactivated`,
`reactivated`, con actor (`humanActor` del servidor) y fecha.

## 5. Validación de un proyecto

Al registrar (y bajo demanda en `GET /projects/:id`):

1. La ruta es absoluta, existe y es un directorio legible y escribible por el
   proceso (escribible solo si `applyMode: real`).
2. Se guarda `realpath`. Si la ruta indicada es un symlink, se registra su destino
   real y se informa (D3: o se rechaza).
3. Es un repositorio: existe `.git` (directorio o archivo, para worktrees). D1
   decide si se exige git o si basta con un directorio.
4. No está dentro de otro proyecto activo ni contiene a uno (evita aplicar en el
   repo equivocado por anidamiento).
5. No es una ruta sensible: `/`, el directorio home completo ni el propio
   directorio de datos de Saiki-IA (`.saiki/`).
6. Huella: `dev` e `ino` del directorio raíz y ruta real de `.git`.

Estado de salud calculado (no persistido) que devuelve la API: `ok`, `missing`
(no existe), `moved` (la ruta existe pero la huella cambió), `not_a_repository`,
`not_accessible`.

## 6. Contratos API (aditivos)

### 6.1. Proyectos

`POST /projects`

```json
{ "name": "app-ionic", "path": "/Users/said/dev/app-ionic", "applyMode": "sandbox" }
```

```json
201 {
  "project": {
    "id": "prj-6f1c…", "name": "app-ionic",
    "rootPath": "/Users/said/dev/app-ionic",
    "status": "active", "applyMode": "sandbox",
    "createdAt": "2026-10-31T10:00:00.000Z", "updatedAt": "…",
    "health": "ok"
  }
}
```

Errores: `400 invalid_path` (no absoluta, no existe, no es directorio),
`400 not_a_repository`, `400 sensitive_path`, `409 already_registered` (incluye
`projectId`), `409 nested_project`, `409 name_taken`.

- `GET /projects?status=active|inactive` → `{ projects: Project[] }` (con `health`).
- `GET /projects/:id` → `{ project }` (revalida la salud al leer); 404.
- `PATCH /projects/:id` → `{ name?, applyMode? }`. La ruta no se edita (D2).
  `applyMode: "real"` exige confirmación explícita (`"confirmRealApply": true`).
- `POST /projects/:id/deactivate` y `POST /projects/:id/activate` → `{ project }`.
  `409 has_active_executions` si se desactiva con ejecuciones en curso (D5).

### 6.2. Sesiones

`POST /sessions` (cambio aditivo: ahora persiste la sesión si llega `projectId`)

```json
{ "projectId": "prj-6f1c…" }
```

```json
201 { "sessionId": "sess-…", "existed": false, "projectId": "prj-6f1c…" }
```

- Sin `projectId`: igual que hoy (sesión general, no persiste hasta el primer
  mensaje).
- `400 project_inactive` o `404 project_not_found`.
- Una sesión existente con otro proyecto: `409 session_project_mismatch`. Nunca se
  reasigna (regla 8).
- `GET /sessions` y `GET /sessions/:id`: incluyen `projectId` (o nada).
  `GET /sessions?projectId=…` filtra.

### 6.3. Mensajes

`POST /sessions/:id/messages` sin cambios de forma. Si el moderador clasifica el
mensaje como desarrollo y la sesión **no tiene proyecto**, no se crea ejecución:

```json
200 { "result": {
  "sessionId": "sess-…", "category": "clarification", "confidence": 0.9,
  "reason": "…",
  "clarifyingQuestion": "Para desarrollar necesito un proyecto. Inicia una sesión nueva eligiendo uno.",
  "blockedReason": "project_required"
} }
```

(`blockedReason` es aditivo; D6 decide entre esto y un error HTTP.)

### 6.4. Ejecuciones

`ExecutionView.project` (aditivo):

```json
"project": { "id": "prj-6f1c…", "name": "app-ionic", "rootPath": "/Users/said/dev/app-ionic",
             "applyMode": "sandbox", "boundAt": "…" }
```

`null` en ejecuciones anteriores al registro (ver §9). Opcional:
`GET /projects/:id/executions`.

### 6.5. Separación de responsabilidades

Los endpoints de proyectos son solo para el humano (API). Ningún agente tiene
acceso: los agentes solo reciben prompts y herramientas de lectura; ni el
moderador ni el grafo pueden registrar, editar o desactivar proyectos.

## 7. Flujo de sesiones y ejecuciones

1. **Crear sesión**: el usuario elige un proyecto (o ninguno). `POST /sessions
   {projectId}` persiste la sesión con `projectId`. Inmutable desde ese momento.
2. **Mensaje de desarrollo**: `process()` comprueba `session.projectId`. Si falta,
   responde con `project_required` (§6.3). Si existe, lee el proyecto del
   registro, lo **revalida** (activo y sano) y, si falla, responde con el motivo
   sin crear la ejecución.
3. **Vinculación**: `runGraph` (primer tramo) inserta `execution_projects` y pasa
   `project` en el estado inicial del grafo. A partir de ahí, la ejecución usa
   solo esa copia, aunque el registro cambie después (renombrar, desactivar).
4. **Nodos**: análisis técnico, desarrollo, aplicación y verificación leen
   `state.project.rootPath` (con el `rootDir` actual como respaldo solo para
   ejecuciones antiguas sin proyecto).
5. **Agentes**: cada llamada pasa `context.workingDirectory = rootPath`; los
   adaptadores lo trasladan a `spawn({ cwd })` (`ProcessRequest.cwd`, aditivo).
6. **Asistencia** (OpenCode) en una sesión con proyecto: mismo `cwd`. En una sesión
   general: sin proyecto (D8).

## 8. Seguridad: la asociación proyecto-ejecución

Capas, de dentro hacia fuera:

1. **Inmutabilidad en el estado**: el reducer de `project` conserva el primer
   valor. Ninguna reanudación ni nodo lo cambia.
2. **Inmutabilidad en SQLite**: `execution_projects` con triggers anti
   `UPDATE`/`DELETE`.
3. **Ruta del proyecto inmutable** en el registro (D2): no se puede "mover" un
   proyecto para que una ejecución en curso apunte a otro sitio.
4. **Guardia antes de aplicar** (hook inyectado en `applyTask`, ejecutado antes de
   cualquier escritura). Comprueba:
   - el estado del grafo y `execution_projects` coinciden (proyecto, ruta y huella);
   - el proyecto sigue activo (D5);
   - la ruta existe, su `realpath` es la misma y no es un symlink nuevo;
   - la huella coincide (`dev`/`ino` y `.git`): detecta repositorio movido,
     borrado y recreado, o sustituido;
   - el directorio de aplicación (real o sandbox) deriva de esa ruta y no de una
     constante global.

   Si algo falla: fase `apply_blocked` (ya existente, ciclo de vida `failed`) con
   el motivo exacto en `errors`. **Nunca** se busca el repositorio en otra ruta.
5. **Escritura**: `resolveSafePath`, hashes base y verificación posterior, sin
   cambios (protegen archivo a archivo dentro de la raíz validada).
6. **Agentes**: `cwd` del proyecto. **Riesgo residual**: `fs_read` de Kiro no está
   confinado a un directorio; un agente podría leer fuera si lo intenta. Es un
   riesgo de lectura (no de escritura: los agentes no escriben). Confinarlo
   requeriría un sandbox de sistema, fuera de alcance.

## 9. Compatibilidad y casos límite

- **Sesiones existentes** (sin `projectId`): pasan a ser sesiones generales.
  Siguen conversando; un desarrollo nuevo en ellas pedirá crear una sesión con
  proyecto (regla 6). Es un cambio de comportamiento visible (D9: con un
  "proyecto heredado" registrado automáticamente, podría suavizarse).
- **Ejecuciones existentes** (sin vinculación): `project: null`. Si alguna está
  pausada, sus nodos usan el `rootDir` actual del backend, como hoy, y la API lo
  indica ("anterior al registro de proyectos").
- **Checkpoints antiguos**: el campo `project` ausente se lee como `null`; no hay
  migración del checkpointer.
- **Dos ejecuciones del mismo proyecto a la vez**: posible; los hashes base del
  Safe Applier ya detectan conflictos si ambas tocan los mismos archivos.
- **Proyecto desactivado con ejecuciones pausadas**: se ven y se pueden rechazar;
  aplicar se bloquea (D5).
- **Repositorio borrado o movido**: `health` lo refleja en la API; aplicar se
  bloquea con el motivo. Para seguir, registrar la nueva ruta como proyecto nuevo.
- **Ruta con symlink en la raíz**: se guarda el destino real; si el symlink cambia
  de destino, la guardia lo detecta (realpath distinto).
- **Mismo repositorio registrado dos veces** (ruta distinta pero mismo destino real
  o mismo `.git`): `409 already_registered`.
- **Proyecto renombrado durante una ejecución**: la ejecución conserva el nombre
  de su copia; la API muestra ambos si difieren.
- **Sandbox**: la copia temporal debe ser por ejecución y del proyecto completo
  (excluyendo `.git`, `node_modules` y artefactos de build), no solo `src/` (D4).

## 10. Frontend

- **Vista "Proyectos"** (`/projects`): lista con nombre, ruta, estado, modo de
  aplicación y salud (`ok`, `movido`, `no existe`…), con forma y texto. Acciones:
  registrar, renombrar, activar y desactivar.
- **Registrar**: formulario con nombre y ruta (texto). El frontend no lee el
  sistema de archivos: envía la cadena y muestra el resultado de la validación del
  backend, con los errores por campo.
- **Nueva solicitud** (inicio): selector de proyecto obligatorio para desarrollar,
  con la opción "Sin proyecto (solo conversación)". La sesión se crea con ese
  proyecto antes del primer mensaje. Si el backend responde `project_required`, se
  explica y se ofrece elegir un proyecto en una sesión nueva.
- **Indicador de proyecto**: en la cabecera de sesión y de ejecución (nombre y
  ruta de la copia de la ejecución), y en las filas del inicio y la columna
  lateral. "Sin proyecto" para sesiones generales y "Anterior al registro" para
  ejecuciones antiguas.
- **Sesión existente**: el selector no aparece; el proyecto se muestra fijo.
- **Estados**: proyecto inactivo o con salud distinta de `ok` → aviso en la sesión
  y en las decisiones (aprobar y aplicar se bloquearía).
- Filtro opcional por proyecto en el inicio.

## 11. Decisiones que necesito

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | ¿Qué es un "repositorio válido"? | a) exigir git (`.git` presente) · b) cualquier directorio | a) Da una huella fiable y encaja con el flujo de desarrollo |
| D2 | ¿Se puede editar la ruta de un proyecto? | a) no: mover = registrar uno nuevo · b) sí, sin efecto en ejecuciones ya vinculadas | a) Elimina una vía de redirigir aplicaciones |
| D3 | Raíz que es un symlink | a) aceptar y guardar el destino real · b) rechazar | a) Con la guardia de `realpath` es seguro |
| D4 | Modo de aplicación | a) por proyecto (`sandbox` por defecto, `real` con confirmación explícita), sandbox por ejecución y del repo completo · b) mantener la variable global actual | a) La global no sirve para varios proyectos y la copia actual solo incluye `src/` |
| D5 | Desactivar un proyecto con ejecuciones pausadas | a) permitir y bloquear sus aplicaciones · b) impedir desactivar mientras existan | a) Desactivar es una decisión de seguridad que debe ganar |
| D6 | Desarrollo sin proyecto | a) `200` con `clarification` y `blockedReason: project_required` · b) `409 project_required` | a) No rompe el contrato de `HandleResult` y Jev ya sabe mostrar aclaraciones |
| D7 | Historial de cambios del registro (`project_history`) | a) incluirlo ahora · b) más adelante | a) Es pequeño y da trazabilidad de quién activó `real` |
| D8 | Asistencia (OpenCode) en sesiones generales | a) sin acceso a repositorio · b) acceso al directorio del backend (como hoy) | a) Coherente con "sin proyecto" |
| D9 | Sesiones y uso actuales | a) solo cambio de comportamiento (las sesiones antiguas son generales) · b) además, registrar automáticamente el repo de Saiki-IA como primer proyecto | b) Mantiene el uso actual sin pasos manuales; es explícito y se ve en la lista |

## 12. Plan de implementación

Cada tarea compila, tiene pruebas y deja todo en verde.

| # | Tarea | Verificación | Tamaño |
|---|---|---|---|
| 1 | `ProjectRegistry` en `CoreStore`: tabla, validación de ruta (§5), huella, salud. | Unitarias con directorios y repos git temporales reales: symlink, anidado, sensible, inexistente, sin `.git`. | M |
| 2 | Endpoints de proyectos (§6.1) y `project_history` si D7. | Integración HTTP: registrar, duplicados, renombrar, activar y desactivar, salud tras mover o borrar. | S |
| 3 | Sesión con proyecto: `POST /sessions {projectId}` persistente e inmutable; `projectId` en las respuestas. | Integración: proyecto inexistente o inactivo, intento de reasignar (`409`), sesiones antiguas intactas. | S |
| 4 | Desarrollo exige proyecto (§6.3) y revalidación al iniciar. | Integración: sesión general con mensaje de desarrollo → sin ejecución; proyecto movido → motivo. | S |
| 5 | Vinculación: `project` en `HuState` (reducer keep-first), `execution_projects` (triggers), `ExecutionView.project`. | Unitarias e integración: inmutable tras reanudar, tras reiniciar y ante un intento de sobrescritura; triggers. | M |
| 6 | Nodos leen la raíz del estado; `ProcessRequest.cwd` y `context.workingDirectory` en los adaptadores. | Integración con dos repos temporales en paralelo: cada agente doble registra su `cwd`; el análisis valida rutas del repo correcto. | M |
| 7 | Guardia de aplicación (§8.4) y sandbox por ejecución (D4). | Integración: proyecto desactivado, repo movido, borrado y recreado, symlink cambiado, discrepancia entre estado y tabla → `apply_blocked` y ningún archivo escrito. Sandbox con proyecto sin `src/`. | M |
| 8 | Compatibilidad: ejecuciones sin proyecto, sesiones antiguas y D9. | Integración con BD y checkpoints de antes del cambio. | S |
| 9 | Frontend: vista de proyectos, registro, selector, indicadores y estados. | Tests de modelo; Chrome real; AccessLint de las pantallas nuevas. | M |
| 10 | Documentación y prueba real. | Ver §13. | S |

## 13. Pruebas

**Unitarias**
- Validación de rutas: absoluta o relativa, inexistente, archivo, sin permisos,
  symlink en la raíz, anidamiento en ambos sentidos, rutas sensibles, `.git` como
  archivo (worktree).
- Huella y salud: cambios de `ino`, de `realpath` y de `.git`.
- Reducer keep-first del campo `project`.

**Integración (grafo, API y SQLite reales; agentes deterministas)**
- Dos proyectos y dos sesiones en paralelo: cada ejecución analiza, propone y
  aplica en su repo; el otro queda intacto (comprobado por hashes de archivos).
- Una ejecución no hereda el proyecto de otra sesión ni de la anterior de la misma
  sesión.
- Reinicio del backend: vinculación y guardia intactas.
- Guardia: cada causa de bloqueo produce `apply_blocked`, su motivo y cero
  escrituras.
- Sesiones: inmutabilidad del proyecto; sesiones generales; `project_required`.
- Compatibilidad: ejecución antigua sin proyecto que se reanuda y aplica como hoy.
- Agentes: el `cwd` llega al proceso (adaptador con runner observado).
- Triggers: `execution_projects` y `project_history` rechazan `UPDATE`/`DELETE`.

**End-to-end real (Kiro y Claude, solo por HTTP y desde Jev)**
- Registrar dos repositorios git temporales pequeños (por ejemplo, uno Node y otro
  con `lib/`); una solicitud en cada uno; comprobar que el análisis técnico y los
  revisores citan archivos del repositorio correcto; aplicar en sandbox.
- Mover el repositorio con una ejecución esperando la aprobación final → aprobar →
  `apply_blocked` con su motivo y sin escrituras.

## 14. Fuera de alcance

Escaneo completo o análisis profundo del repositorio, documentación técnica
generada, carpeta `.saiki/` dentro de los proyectos, Project Analyst, indexación
semántica, RAG, Context Builder, automatizaciones de contexto, confinamiento de
lectura de los agentes a nivel de sistema operativo, y nueva infraestructura.
