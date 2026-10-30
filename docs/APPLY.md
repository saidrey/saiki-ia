# Fase 13 — Aprobación humana final y aplicación segura

> Nombre oficial: `saiki-ia`. Esta es la etapa que toma una propuesta ya revisada
> (funcional + calidad), pide tu autorización explícita, aplica EXACTAMENTE esa
> versión y demuestra qué ocurrió, incluso si algo falla.

## 1. Qué hace

Después de que ambas revisiones (funcional y calidad) aprueban la MISMA versión
de la propuesta (mismo hash SHA-256), el flujo:

1. Presenta al humano un resumen completo: implementación, archivos a crear /
   modificar / eliminar, resultado de ambas revisiones, riesgos y el hash.
2. Pide una decisión explícita: **aprobar**, **rechazar** o **solicitar cambios**.
3. Si se aprueba, aplica la propuesta de forma segura (único punto de escritura).
4. Verifica el resultado contra la propuesta aprobada.
5. Registra una auditoría completa y deja el estado persistido.

Una interrupción, timeout, reinicio o ausencia de respuesta **NUNCA** se
interpreta como aprobación.

## 2. Estados del flujo

Añadidos en `src/hu/hu-state.ts` (`HuPhase`):

| Estado                        | Significado |
|-------------------------------|-------------|
| `awaiting_final_approval`     | Ambas revisiones OK; se presenta al humano y se pausa. |
| `final_approval_rejected`     | El humano rechazó definitivamente. No se aplica nada. |
| `ready_to_apply`              | Aprobado por el humano; hashes verificados; listo para aplicar. |
| `applying`                    | Aplicación en curso (transitorio; marcado antes de escribir). |
| `applied`                     | Aplicado y verificado con éxito. |
| `applied_with_test_failures`  | Aplicado y verificado, pero tests/typecheck del proyecto fallaron. |
| `rolled_back`                 | Falló al aplicar; se revirtieron los cambios parciales (repo intacto). |
| `unrecoverable`               | Falló al aplicar Y el rollback no se completó (revisión manual). |
| `apply_blocked`               | Bloqueado antes de escribir (hash no coincide / propuesta inválida). |

Las transiciones están validadas: no se puede saltar las revisiones ni la
aprobación humana. El nodo de aprobación sigue siendo un `interrupt()` que PAUSA
el grafo hasta recibir una decisión explícita.

## 3. Cómo se valida el hash (lo aprobado == lo aplicado)

La aprobación está atada a `hashDevProposal` (el hash SHA-256 de la propuesta de
Claude, en `src/dev/dev-schema.ts`). La cadena de verificación es:

1. Las revisiones funcional y de calidad aprueban guardando su hash
   (`functionalApprovedHash`, `qualityApprovedHash`).
2. La **invariante del PO** (`bothReviewsTask`): solo se pide aprobación final si
   `functionalApprovedHash === qualityApprovedHash === devProposalHash`.
3. En la aprobación final, al aprobar se fija `finalApprovedHash = devProposalHash`
   (re-verificando la invariante; defensa adicional).
4. En `applyTask`, ANTES de escribir, se recalcula `hashDevProposal(proposal)` y
   se compara con `finalApprovedHash`. Si no coincide, **no se escribe nada**
   (`apply_blocked`): la aprobación no vale para otra versión.
5. El puente (`src/apply/dev-proposal-bridge.ts`) vuelve a verificar la
   integridad (`hashDevProposal === approvedDevHash`) y, tras convertir la
   propuesta al formato del aplicador, el aplicador transaccional verifica su
   PROPIO hash interno (`hashProposal`) contra la propuesta convertida. Así lo
   que se escribe === lo convertido === lo aprobado.

Si Claude corrige la propuesta (solicitud de cambios), el hash cambia y **todas**
las aprobaciones previas (funcional, calidad, final) quedan invalidadas: se
re-revisa desde funcional.

## 4. Aplicación segura (reutiliza el aplicador existente)

No se creó un segundo aplicador. Se reutiliza `applyProposalTransactional`
(`src/apply/transactional-applier.ts`, Fase 7), extendido en Fase 13 para
soportar la operación `delete`. El puente `applyDevProposal` convierte las
operaciones del dominio HU (`create` / `modify` / `delete`) al formato del
aplicador (`create` / `update` / `delete`).

Controles ANTES de escribir (sin debilitarlos):

- Validación de rutas (`resolveSafePath`): rechaza rutas absolutas, traversal
  `../` y symlinks que escapen del directorio autorizado.
- Detección de cambios concurrentes: `computeExpectedBaseHashes` lee el disco
  actual de los archivos a modificar/eliminar; si difieren de lo esperado, el
  aplicador **rechaza** sin sobrescribir.
- `create` no puede sobrescribir un archivo existente; `update`/`delete` exigen
  que el archivo exista.
- Snapshot del estado previo de cada archivo (contenido o "no existía") para
  poder restaurar.

El único componente autorizado para modificar el repositorio es el aplicador
controlado. Ni Claude ni Kiro escriben en esta etapa (ni en ninguna otra).

## 5. Rollback: garantías y LIMITACIONES (honestas)

El sistema de archivos **NO es transaccional**. No fingimos atomicidad. Lo que
se ofrece es rollback **best-effort con reporte explícito**:

- Si una escritura falla a mitad, se intenta restaurar los archivos ya escritos
  desde el snapshot previo.
- Si la restauración **tiene éxito**: estado `rolled_back`. El repo queda en su
  estado anterior (los cambios parciales se revirtieron).
- Si la restauración **también falla**: estado `unrecoverable`. NO se reporta
  éxito. Se informan explícitamente los archivos afectados y lo que no se pudo
  restaurar. Requiere revisión manual.

**Limitación conocida**: entre la lectura del snapshot y la escritura/restauración
no hay bloqueo del FS; un proceso externo que modifique los mismos archivos en
paralelo puede interferir. Mitigación: la detección de cambios concurrentes
(hashes base) reduce la ventana, y la primera prueba integral se hace sobre una
copia temporal, no sobre el repo real.

## 6. Verificación posterior

`src/apply/verify-applied.ts` compara el repo real contra la propuesta aprobada:

- `create`/`modify`: el archivo debe existir y su contenido debe ser EXACTAMENTE
  el propuesto.
- `delete`: el archivo ya no debe existir.

Cualquier discrepancia se reporta (`mismatches`) y la aplicación NO se considera
exitosa (pasa a `unrecoverable`, porque se escribió pero el resultado no coincide).

Distinción explícita de resultados:

- **Aplicación exitosa** (`applied`): contenido coincide con lo aprobado.
- **Exitosa con pruebas fallidas** (`applied_with_test_failures`): el contenido
  coincide, pero los tests/typecheck del proyecto fallaron. Los checks del
  proyecto son **opt-in** (hook `runChecks`); el grafo no los ejecuta por
  defecto (serían no deterministas). Una aplicación exitosa NO implica que todas
  las pruebas del proyecto pasen.
- **Parcial con rollback** (`rolled_back`): falló, pero se revirtió.
- **Parcial con recuperación incompleta** (`unrecoverable`): falló y no se pudo
  revertir.

## 7. Idempotencia y recuperación de ejecución interrumpida

- Tras aplicar, se persiste `appliedHash` (= hash DEV aplicado) y un
  `applicationId` único.
- Si el proceso se reinicia y se reanuda el mismo `thread_id`, el estado
  persistido en SQLite se recupera. Si `appliedHash` ya coincide con el hash de
  la propuesta, el aplicador devuelve `noop` y **NO reescribe** (no duplica
  respaldos ni registros).
- **Advertencia honesta**: un estado persistido `applied` indica que el flujo
  registró la aplicación, no es una garantía de que los archivos en disco sigan
  intactos (un tercero pudo editarlos). Por eso la verificación posterior compara
  el disco real contra la propuesta.

## 8. Auditoría (sin secretos)

`ApplicationAudit` (en el estado, `auditRecord`) registra: `applicationId`, hash
aprobado, decisiones funcional/calidad, decisión humana, fecha de aprobación,
archivos afectados, referencia del respaldo, outcome de aplicación, resumen de
verificación, resumen de rollback y notas/errores. No se almacenan credenciales,
tokens ni secretos.

## 9. Prueba manual de integración (opt-in)

`npm run manual:tech` ejecuta el flujo completo con agentes reales (HU → técnico
→ desarrollo → revisión funcional → revisión de calidad → aprobación humana →
aplicación segura).

### Protección contra el repo real (doble autorización)

- El **análisis** lee el repo real (solo lectura).
- La **aplicación** escribe por defecto sobre una **COPIA TEMPORAL** del repo,
  NUNCA sobre el repo real.
- Para aplicar sobre el repo REAL se exigen DOS autorizaciones deliberadas:
  1. Variable de entorno `SAIKI_APPLY_TO_REAL_REPO=1`.
  2. Confirmación interactiva escribiendo exactamente: `APLICAR EN REAL`.
  Si falta cualquiera de las dos, se usa la copia temporal (seguro por defecto).

La copia temporal se conserva al terminar para que puedas inspeccionar los
cambios aplicados; su ruta se informa en la evidencia.

## 10. Restricciones respetadas

- No se incorporaron nuevos proveedores de IA ni Codex.
- No se crearon agentes especializados ni el moderador conversacional.
- No se añadió UI ni Jev.
- No se modificaron las responsabilidades de los agentes existentes.
- No se eliminó la aprobación humana.
- No se permiten escrituras fuera del aplicador seguro.
- No se debilitaron las protecciones de fases anteriores.

## 11. Riesgos pendientes

- El rollback es best-effort, no atómico (limitación del FS). Documentado arriba.
- Los checks del proyecto (tests/typecheck) tras aplicar son opt-in; en el flujo
  automático por defecto no se ejecutan.
- La detección de cambios concurrentes cubre los archivos a modificar/eliminar,
  pero no bloquea el FS durante la escritura.
- `applyDir` por defecto == `rootDir`; el manual lo separa a una copia temporal,
  pero un integrador que use `buildHuGraph` directamente sobre el repo real
  aplicará sobre él (por diseño, bajo su control).

## 12. Archivos relevantes

- `src/apply/transactional-applier.ts` — aplicador best-effort (extendido con `delete`).
- `src/apply/file-change.ts` — `FileOperation` ahora incluye `delete`.
- `src/apply/dev-proposal-bridge.ts` — puente DevProposal → aplicador + idempotencia.
- `src/apply/verify-applied.ts` — verificación posterior contra la propuesta.
- `src/hu/hu-state.ts` — estados y campos de auditoría/idempotencia de Fase 13.
- `src/hu/hu-graph.ts` — nodos `finalApprovalTask`, `applyTask`, `verifyTask`.
- `src/manual/tech-integration.ts` — prueba manual con copia temporal protegida.
- Tests: `src/apply/dev-proposal-bridge.test.ts`, `src/apply/verify-applied.test.ts`,
  `src/hu/apply-flow.test.ts`.
