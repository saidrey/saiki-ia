import type { PendingApprovalView } from "../api/types";
import { useNow } from "../hooks/useNow";
import { elapsed } from "../model/format";
import { approvalKindLabel } from "../model/stages";
import { StageMark } from "./StageMark";
import styles from "./GateBanner.module.css";

const EXPLANATION: Record<string, string> = {
  hu_review: "Saiki-IA generó la historia de usuario y no continuará hasta que la revises.",
  feasibility_partial:
    "El análisis técnico encontró partes implementables y otras que dependen de decisiones. Nada se desarrolla hasta que decidas.",
  final_approval: "Las dos revisiones aprobaron la misma versión de la propuesta. Nada se aplica hasta que decidas.",
};

const DECIDABLE = new Set(["hu_review", "feasibility_partial", "final_approval"]);

interface Props {
  pending: PendingApprovalView;
  onReview: () => void;
  /** Momento en que se envió una decisión de esta pestaña aún en curso. */
  decidingSince: number | null;
}

/** Aviso de que la ejecución espera una decisión humana (según `pendingApproval`). */
export function GateBanner({ pending, onReview, decidingSince }: Props) {
  const now = useNow(decidingSince !== null);
  if (!pending.required) return null;
  const title = approvalKindLabel(pending.kind);
  const decidable = pending.kind !== undefined && DECIDABLE.has(pending.kind);
  return (
    <section className={styles.banner} aria-labelledby="gate-title">
      <StageMark state="awaiting" size={24} />
      <div className={styles.body}>
        <h2 id="gate-title" className={styles.title}>
          Necesita tu decisión: {title}
        </h2>
        <p className={styles.text}>
          {decidingSince !== null
            ? `Decisión enviada (${elapsed(now - decidingSince)}). Saiki-IA está trabajando; la vista se actualiza sola.`
            : (pending.kind !== undefined && EXPLANATION[pending.kind]) || "La ejecución está pausada hasta tu decisión."}
        </p>
        {!decidable ? <p className={styles.text}>La interfaz no sabe resolver este tipo de aprobación.</p> : null}
      </div>
      {decidable ? (
        <button type="button" className={styles.action} onClick={onReview} disabled={decidingSince !== null}>
          {decidingSince !== null ? "Decisión en curso" : "Revisar y decidir"}
        </button>
      ) : null}
    </section>
  );
}
