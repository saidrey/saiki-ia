# Fase 7 — Persistencia durable y recuperación segura

Permite que saiki-ia sobreviva a reinicios del proceso sin perder aprobaciones
pendientes, sin aplicar dos veces una propuesta, y sin declarar éxito cuando la
aplicación queda incompleta.

## 1. Persistencia durable (SQLite)

- Checkpointer: `@langchain/langgraph-checkpoint-sqlite@1.1.0` (`SqliteSaver`),
  verificado compatible con `@langchain/langgraph@1.5.3`.
- `src/persistence/checkpointer.ts` → `createSqliteCheckpointer(dbPath)`.
- Ubicación por defecto: `.saiki/checkpoints.sqlite` (configurable). Excluida de
  git (`.gitignore`: `.saiki/`, `*.sqlite*`).
- `buildGraph()` usa SQLite persistente por defecto; los tests inyectan memoria
  o un SQLite en directorio temporal.
- Compatible con `interrupt()`, `Command({ resume })` y el mismo `thread_id`
  (verificado: una NUEVA instancia del grafo, apuntando al mismo archivo,
  recupera el estado y reanuda).

### Configurar / inicializar / respaldar

- Inicializar: no requiere pasos; el archivo se crea solo al primer uso.
- Configurar ubicación: `buildGraph({ checkpointer: createSqliteCheckpointer("/ruta/db.sqlite") })`.
- Respaldar: copiar el archivo `.sqlite` (más `-wal`/`-shm` si existen) con el
  proceso detenido. Es un único archivo local.

## 2. Recuperación de aprobaciones pendientes

- Tras un reinicio, el estado (propuesta, `proposalHash`, `thread_id`,
  `approvalPhase`) se recupera del SQLite.
- Una propuesta `pending` NUNCA pasa a `approved` por defecto: sigue pendiente
  hasta que llega un `Command({ resume: { action: "approve" } })` explícito.
- La reanudación continúa la ejecución existente (mismo `thread_id`), no arranca
  otra desde cero.

## 3. Idempotencia (no aplicar dos veces)

- El estado registra `appliedHash`: el hash de la propuesta ya aplicada con éxito.
- `applyProposalTransactional` recibe `alreadyAppliedHash`. Si coincide con el
  hash de la propuesta, devuelve `outcome: "noop"` y NO reescribe archivos.
- Esto protege contra reintentos, reanudaciones repetidas y reinicios.
- Se mantiene la verificación de que la propuesta aplicada coincide exactamente
  con la aprobada (hash SHA-256; una propuesta alterada tras aprobar → rejected).

## 4. Recuperación ante fallos parciales (best-effort, honesto)

**Limitación declarada**: el sistema de archivos NO es transaccional. No se
ofrece atomicidad real. Lo implementado es **best-effort con snapshot y reporte
explícito**, NO una transacción. Mecanismo (`src/apply/transactional-applier.ts`):

1. Antes de escribir, se valida todo (rutas, conflictos) y se toma un **snapshot**
   del estado previo de cada archivo (contenido o "no existía").
2. Se aplican los cambios en orden.
3. Si una escritura falla a mitad, se hace **rollback**: restaurar el contenido
   previo o eliminar los archivos que no existían. Resultado: `rolled_back`.
4. Si el rollback TAMBIÉN falla, NO se declara éxito: `outcome: "unrecoverable"`
   con un **informe explícito** (`recoveryReport`) de qué archivos quedaron
   afectados y qué no se pudo restaurar. Requiere revisión manual.
5. Nunca se sobrescriben cambios concurrentes del usuario (detección por
   `expectedBaseHashes`).

`outcome` posibles: `applied`, `noop`, `rolled_back`, `unrecoverable`, `rejected`.

No se ejecutan comandos generados por los agentes para aplicar ni restaurar.

## 5. Estado persistido ausente/corrupto

Si se intenta reanudar un `thread_id` inexistente, `getState` devuelve un estado
vacío (sin propuesta) y el grafo no reanuda nada (no inventa una aprobación).

## Pruebas (51 en total, deterministas, dir temporal, sin SSO)

- `src/persistence/recovery.test.ts` (5): recuperación en nueva instancia tras
  "reinicio", propuesta+hash sobreviven, pendiente no se auto-aprueba, aplica
  exactamente una vez, idempotencia.
- `src/apply/transactional-applier.test.ts` (8): aplica + registra hash, noop
  idempotente, rollback multi-archivo restaura previos, conflicto concurrente,
  hash distinto rechazado, traversal rechazado, `unrecoverable` con informe.
- Más todas las pruebas de fases 1–6.

## Riesgos / limitaciones pendientes

- **No es atomicidad real**: el rollback es best-effort. En el peor caso
  (rollback falla) el repo puede quedar en estado intermedio; eso se REPORTA, no
  se oculta. Un rollback verdaderamente seguro requeriría staging (escribir a un
  área temporal y mover atómicamente), fuera del alcance KISS de esta fase.
- SQLite `-wal` puede dejar archivos auxiliares; respaldar con el proceso parado.
- `review` sigue simulado; sin Codex/Godot/GUI/WebSocket.
