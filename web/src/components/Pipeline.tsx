import type { ExecutionView, StageId } from "../api/types";
import { approvalKindLabel, gateAfterStage, stateLabel, stationState, trackAfter } from "../model/stages";
import { StageMark } from "./StageMark";
import styles from "./Pipeline.module.css";

interface Props {
  view: ExecutionView;
  /** Actividad observada en vivo: solo activa el pulso de la etapa en curso. */
  live: boolean;
  selectedId: StageId;
  onSelect: (id: StageId) => void;
}

/** Las 9 etapas de `ExecutionView.stages` como estaciones seleccionables sobre una vía. */
export function Pipeline({ view, live, selectedId, onSelect }: Props) {
  const states = view.stages.map((s) => stationState(s, view));
  const gateStage = gateAfterStage(view);
  const gateIndex = gateStage === null ? -1 : view.stages.findIndex((s) => s.id === gateStage);
  const last = states.length - 1;

  return (
    <ol className={styles.pipeline}>
      {view.stages.map((stage, i) => {
        const state = states[i];
        const hasGate = i === gateIndex;
        return (
          <li key={stage.id} className={styles.station} data-state={state}>
            <button
              type="button"
              className={styles.button}
              aria-pressed={stage.id === selectedId}
              aria-controls="stage-inspector"
              onClick={() => onSelect(stage.id)}
            >
              <span className={styles.number}>{i + 1}</span>
              <span className={styles.rail}>
                <span className={styles.track} data-side="in" data-track={i === 0 ? "none" : trackAfter(states, i - 1, gateIndex)} />
                <StageMark state={state} live={live} />
                <span className={styles.track} data-side="out" data-track={i === last ? "none" : trackAfter(states, i, gateIndex)} />
                {hasGate ? (
                  <span className={styles.gate}>
                    <StageMark state="awaiting" size={20} />
                  </span>
                ) : null}
              </span>
              <span className={styles.text}>
                <span className={styles.label}>{stage.label}</span>
                <span className={styles.state}>{stateLabel(state, view)}</span>
                {hasGate ? (
                  <span className={styles.gateText}>Señal: espera tu decisión ({approvalKindLabel(view.pendingApproval.kind)})</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
