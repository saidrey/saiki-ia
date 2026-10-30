# Fase 6 — Human-in-the-loop (aprobación antes de aplicar)

Mecanismo que PAUSA el grafo cuando hay una propuesta de código y espera una
decisión humana (approve/reject) antes de aplicar cualquier cambio al disco.

## Flujo

```
Kiro (analyze) → Claude (develop, propuesta) → proposeTask (estructura + hash)
  → approvalTask  [interrupt(): PAUSA]
      - approve → applyTask (aplicación controlada) → reviewTask → ...
      - reject  → failTask (repo intacto)
```

## Pausa y reanudación (LangGraph)

- `interrupt(payload)` detiene el grafo en `approvalTask`. Verificado contra
  `@langchain/langgraph` v1.5.3.
- El grafo se compila con un **checkpointer** (`MemorySaver` por defecto), que
  persiste el estado durante la pausa. Sin checkpointer, interrupt/resume no
  funciona.
- `invoke(initialState, { configurable: { thread_id } })` corre hasta la pausa
  y devuelve `__interrupt__` con el payload para el humano.
- Se reanuda con `invoke(new Command({ resume: decision }), { configurable: {
  thread_id } })` usando **el mismo `thread_id`**. El estado (incluida la
  propuesta) sobrevive a la interrupción.
- La pausa NO se simula con sleep, booleanos ni re-ejecución del grafo.

## Qué ve el humano (payload del interrupt)

- `proposalId`: identificador de la propuesta.
- `proposalHash`: SHA-256 de la propuesta (lo que se aprueba).
- `files`: lista de archivos a modificar (ruta + operación).
- `summary`: resumen legible de los cambios.

Decisiones: `{ action: "approve" }` o `{ action: "reject" }`. Cualquier cosa que
no sea `approve` explícito es rechazo. Ausencia de respuesta = sigue pausado
(NO se aprueba por timeout/ausencia/error).

## Aplicación controlada (lo crítico)

- Claude NUNCA escribe (sigue con `--tools ""`, Fase 5). La escritura la hace el
  **aplicador** (`src/apply/applier.ts`), código nuestro, separado del modelo.
- No se ejecutan comandos de shell ni scripts propuestos por el modelo.
- Formato estructurado `FileChange { path, operation, content }`. La propuesta
  se deriva del texto de Claude mediante una convención `FILE: <ruta>` + bloque
  de código (ver "Limitación" abajo).
- **"Lo aprobado == lo aplicado"**: se aprueba un hash; el aplicador solo escribe
  si `hashProposal(propuesta) === approvedHash`. Si la propuesta cambia tras la
  aprobación, el hash difiere y se rechaza (exige nueva aprobación).
- Validación de rutas (`src/apply/path-validation.ts`): rechaza rutas absolutas,
  traversal `../`, symlinks que escapan del directorio y cualquier destino fuera
  del directorio autorizado.
- Detección de conflictos: si un archivo en disco difiere de la base que la
  propuesta asumió (`expectedBaseHashes`), se aborta sin sobrescribir.
- Fallo parcial: si la escritura falla a mitad, se reporta `partial` con los
  archivos ya escritos. NUNCA se declara éxito si quedó incompleto.
- `create` no sobrescribe archivos existentes.

## Estado del ciclo (`approvalPhase`)

`none` → `pending` → (`approved` → `applied` | `apply_failed`) | `rejected`.
Más: `proposal`, `proposalHash`, `appliedFiles`, `applyError`.

## Limitación documentada

Claude en modo propuesta devuelve **texto libre**, no un formato máquina. No se
inventa una capacidad de la CLI. La solución: pedir en el prompt la convención
`FILE: <ruta>` + bloque de código, y un **parser determinista nuestro**
(`src/apply/proposal-parser.ts`) la convierte en `FileChange[]`. Si el texto no
sigue la convención, el parser devuelve 0 cambios y el flujo termina en fallo
("sin cambios aplicables"), sin inventar contenido ni abrir aprobación ficticia.

## Pruebas

Deterministas, en directorio temporal, sin SSO ni llamadas reales:
`src/graph.test.ts` (flujo HITL: pausa, persistencia, mismo thread_id, approve
aplica, reject intacto, ausencia no aprueba) y `src/apply/applier.test.ts`
(hash modificado se rechaza, rutas peligrosas, conflicto concurrente, fallo
visible). Total suite: 39 tests.

## Prueba manual (opt-in)

- `npm start`: demo HITL en dir temporal (approve aplica, reject intacto).
- `npm run manual:kiro` / `npm run manual:claude`: flujo con agentes reales; los
  cambios aprobados van a un dir TEMPORAL y se verifica que el repo real queda
  intacto.

## Riesgos / limitaciones pendientes

- El checkpointer es `MemorySaver` (en memoria): no sobrevive a reinicios del
  proceso. Para durabilidad real haría falta un checkpointer persistente.
- La convención `FILE:` depende de que el modelo la respete; si no, no hay
  propuesta aplicable (falla seguro, no aplica basura).
- `review` sigue simulado. Codex, Godot, WebSocket, GUI: fuera de alcance.
- Aún no hay control de versiones/rollback de los cambios aplicados.
