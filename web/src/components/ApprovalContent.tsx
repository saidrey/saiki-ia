import type { ExecutionStage, FeasibilityGateView, HuReviewGateView, ProposalView } from "../api/types";
import styles from "./ApprovalDialog.module.css";

/** Lista con título; si está vacía, lo dice (no se oculta un dato vacío como si no existiera). */
function Items({ title, items, empty, mono = false }: { title: string; items: string[]; empty?: string; mono?: boolean }) {
  if (items.length === 0 && empty === undefined) return null;
  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className={styles.muted}>{empty}</p>
      ) : (
        <ul className={mono ? `${styles.list} ${styles.mono}` : styles.list}>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HuContent({ gate }: { gate: HuReviewGateView }) {
  const { hu } = gate;
  return (
    <>
      <p className={styles.muted}>
        Versión {gate.version} de la HU. Revisiones usadas: {gate.revisionsUsed} de {gate.maxRevisions}.
      </p>
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Resumen</h3>
        <p className={styles.prose}>{hu.summary}</p>
      </div>
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Necesidad</h3>
        <p className={styles.prose}>{hu.need}</p>
      </div>
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Tareas ({hu.tasks.length})</h3>
        <ol className={styles.list}>
          {hu.tasks.toSorted((a, b) => a.order - b.order).map((t) => (
            <li key={t.order}>{t.description}</li>
          ))}
        </ol>
      </div>
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Criterios de aceptación ({hu.acceptanceCriteria.length})</h3>
        <ul className={styles.list}>
          {hu.acceptanceCriteria.map((c) => (
            <li key={c.id}>
              <span className={styles.mono}>{c.id}</span> {c.description}
            </li>
          ))}
        </ul>
      </div>
      <Items title="Preguntas abiertas" items={hu.openQuestions} empty="Ninguna." />
      <Items title="Supuestos" items={hu.assumptions} />
      <Items title="Dependencias" items={hu.dependencies} />
    </>
  );
}

export function FeasibilityContent({ gate }: { gate: FeasibilityGateView }) {
  const a = gate.technicalAnalysis;
  return (
    <>
      <p className={styles.muted}>
        Clasificación: <span className={styles.mono}>{gate.feasibility}</span>
      </p>
      <Items title="Motivos" items={gate.reasons} empty="La API no devolvió motivos." />
      <Items title="Rutas no verificables" items={gate.unresolvedPaths} mono />
      {a === null ? (
        <p className={styles.muted}>No disponible: la API no devolvió el análisis técnico.</p>
      ) : (
        <>
          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Análisis técnico</h3>
            <p className={styles.prose}>{a.summary}</p>
          </div>
          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Cambios propuestos ({a.proposedChanges.length})</h3>
            <ul className={styles.list}>
              {a.proposedChanges.map((c, i) => (
                <li key={i}>
                  <span className={styles.mono}>{c.path}</span> {c.change}
                </li>
              ))}
            </ul>
          </div>
          <Items title="Preguntas abiertas" items={a.openQuestions} empty="Ninguna." />
          <Items title="Riesgos" items={a.risks} empty="Ninguno." />
          <details className={styles.details}>
            <summary>Flujo actual y archivos afectados</summary>
            <p className={styles.prose}>{a.currentFlow}</p>
            <ul className={styles.list}>
              {a.affectedFiles.map((f, i) => (
                <li key={i}>
                  <span className={styles.mono}>{f.path}</span> {f.responsibility}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}

export function ProposalContent({ proposal, reviews }: { proposal: ProposalView; reviews: ExecutionStage[] }) {
  return (
    <>
      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Resumen</h3>
        <p className={styles.prose}>{proposal.summary}</p>
      </div>
      <div className={styles.files}>
        <Items title="Crear" items={proposal.filesToCreate} empty="Ninguno." mono />
        <Items title="Modificar" items={proposal.filesToModify} empty="Ninguno." mono />
        <Items title="Eliminar" items={proposal.filesToDelete} empty="Ninguno." mono />
      </div>
      <Items title="Riesgos" items={proposal.risks} empty="Ninguno." />
      {reviews.map((r) => (
        <div key={r.id} className={styles.block}>
          <h3 className={styles.blockTitle}>{r.label}</h3>
          <p className={styles.prose}>{r.detail ?? "No disponible: el backend no registró un resumen."}</p>
        </div>
      ))}
    </>
  );
}
