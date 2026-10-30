import type { ExecutionView } from "../api/types";
import { progressSummary, stationState } from "../model/stages";
import styles from "./MiniRail.module.css";

/** Las 9 etapas como tramos cortos, con su resumen accesible. */
export function MiniRail({ view }: { view: ExecutionView }) {
  return (
    <span className={styles.rail} role="img" aria-label={progressSummary(view)}>
      {view.stages.map((stage) => (
        <span key={stage.id} className={styles.segment} data-state={stationState(stage, view)} />
      ))}
    </span>
  );
}
