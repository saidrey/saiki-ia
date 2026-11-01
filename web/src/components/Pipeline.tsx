import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ExecutionView, StageId } from "../api/types";
import { showsAvatar, STAGE_RESPONSIBLE } from "../model/agents";
import { handoffsBetween, PIPELINE_PHASES, segmentPath, STAGES_PER_ROW, type Handoff, type NodeBox } from "../model/pipeline";
import { approvalKindLabel, gateAfterStage, stateLabel, stationState, trackAfter, type StationState } from "../model/stages";
import { AgentAvatar } from "./AgentAvatar";
import styles from "./Pipeline.module.css";

interface Props {
  view: ExecutionView;
  /** Actividad real en curso: solo entonces gira el nodo activo y se ilumina su entorno. */
  live: boolean;
  /** Eventos SSE recibidos en vivo; cada incremento dispara un pulso hacia la etapa en curso. */
  pulse: number;
  /** Abre el detalle de la etapa. */
  onOpen: (id: StageId) => void;
  /** Decisión humana pendiente: acceso directo junto a su etapa (null si no hay ninguna). */
  decision: { onReview: () => void; busy: boolean } | null;
}

/** Mitad del ancho máximo de la etiqueta de una etapa (`.button`: 240 px). */
const LABEL_HALF_WIDTH = 120;

/** Nodo de etapa: cada estado con forma propia (no solo color). Decorativo; el estado va en texto. */
function StageNode({ state }: { state: StationState }) {
  return (
    <svg className={styles.node} viewBox="0 0 56 56" aria-hidden="true">
      {state === "done" ? (
        <>
          <circle className={styles.halo} cx="28" cy="28" r="25" />
          <circle className={styles.body} cx="28" cy="28" r="20" />
          <path className={styles.ink} d="M20 28.5l5.2 5.2L36 23" />
        </>
      ) : state === "running" ? (
        <>
          <circle className={styles.body} cx="28" cy="28" r="20" />
          <g className={styles.arc}>
            <circle cx="28" cy="28" r="25" strokeDasharray="36 122" />
          </g>
          <circle className={styles.core} cx="28" cy="28" r="5.5" />
          <circle className={styles.inner} cx="28" cy="28" r="10" />
        </>
      ) : state === "awaiting" ? (
        <>
          <path className={styles.body} d="M28 4l24 24-24 24L4 28z" />
          <circle className={styles.core} cx="28" cy="25" r="3.6" />
          <path className={styles.ink} d="M21 36c1.4-4.6 12.6-4.6 14 0" />
        </>
      ) : state === "failed" ? (
        <>
          <circle className={styles.body} cx="28" cy="28" r="20" />
          <path className={styles.ink} d="M22 22l12 12M34 22L22 34" />
        </>
      ) : state === "skipped" || state === "not_applicable" ? (
        <>
          <circle className={styles.body} cx="28" cy="28" r="20" />
          <path className={styles.ink} d="M21 28h14" />
        </>
      ) : (
        <>
          <circle className={styles.body} cx="28" cy="28" r="20" />
          <circle className={styles.core} cx="28" cy="28" r="2.6" />
        </>
      )}
    </svg>
  );
}

/** Posición real de cada nodo (las conexiones SVG se dibujan sobre ella y se recalculan al cambiar el tamaño). */
function useNodeBoxes() {
  const ref = useRef<HTMLOListElement>(null);
  const [layout, setLayout] = useState<{ w: number; h: number; boxes: NodeBox[] }>({ w: 0, h: 0, boxes: [] });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const boxes = [...el.querySelectorAll<HTMLElement>("[data-cell]")].map((cell) => {
        const n = (cell.querySelector("[data-node]") ?? cell).getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        return {
          x: n.left - base.left + n.width / 2,
          y: n.top - base.top + n.height / 2,
          r: n.width / 2,
          cellTop: c.top - base.top,
          cellBottom: c.bottom - base.top,
        };
      });
      setLayout({ w: base.width, h: base.height, boxes });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...layout };
}

/** Duración de cada relevo de luz; varios en un mismo sondeo van en cascada. */
const HANDOFF_MS = 900;

/**
 * Relevos observados en vivo: cuando una etapa se enciende tras completarse la
 * anterior. Al cargar no se anima nada (solo los cambios que ocurren mientras se mira).
 */
function useHandoffs(states: StationState[]) {
  const prev = useRef<StationState[] | null>(null);
  const [batch, setBatch] = useState<{ id: number; items: Handoff[] }>({ id: 0, items: [] });
  const signature = states.join(",");
  useEffect(() => {
    const items = handoffsBetween(prev.current, states);
    prev.current = states;
    if (items.length > 0) setBatch((b) => ({ id: b.id + 1, items }));
    // `states` cambia de identidad en cada render; la firma es lo que importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return batch;
}

const delay = (k: number, extra = 0): CSSProperties => ({ animationDelay: `${k * HANDOFF_MS + extra}ms` });

/** Las 9 etapas reales de `ExecutionView.stages` como nodos de luz, en tres filas unidas por una sola vía. */
export function Pipeline({ view, live, pulse, onOpen, decision }: Props) {
  const states = view.stages.map((s) => stationState(s, view));
  const gateStage = gateAfterStage(view);
  const gateIndex = gateStage === null ? -1 : view.stages.findIndex((s) => s.id === gateStage);
  const { ref, w, h, boxes } = useNodeBoxes();
  const activeIndex = live ? states.indexOf("running") : -1;
  const ready = boxes.length === view.stages.length;
  const handoffs = useHandoffs(states);
  // La decisión se ancla a la etapa que espera (aprobación final) o a la que precede a la puerta (HU, viabilidad parcial).
  const decisionStage = view.awaitingDecision?.stageId ?? view.awaitingDecision?.afterStageId;
  const decisionIndex = decision && view.pendingApproval.required && decisionStage ? view.stages.findIndex((s) => s.id === decisionStage) : -1;

  return (
    <div className={styles.frame}>
      {ready ? (
        <svg className={styles.wires} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
          {boxes.slice(0, -1).map((a, i) => {
            // Holgura: el bucle de cambio de fila pasa fuera de la etiqueta más ancha (botón de 240 px como máximo).
            const seg = segmentPath(a, boxes[i + 1], 16, Math.max(36, LABEL_HALF_WIDTH - a.r + 8));
            return (
              <g key={view.stages[i].id}>
                {/* Halo: lo recorrido queda iluminado; lo pendiente sigue a oscuras (sin halo). */}
                <path className={styles.wireHalo} data-track={trackAfter(states, i, gateIndex)} d={seg.d} />
                <path className={styles.wire} data-track={trackAfter(states, i, gateIndex)} d={seg.d} />
                {/* Un pulso por evento en vivo, por la vía real hacia la etapa que trabaja (la `key` reinicia la animación). */}
                {i + 1 === activeIndex ? (
                  <>
                    {/* Carga: luz que fluye hacia la etapa mientras trabaja (solo con actividad real). */}
                    <path className={styles.flow} d={seg.d} pathLength={100} />
                    <path className={`${styles.flow} ${styles.flowLate}`} d={seg.d} pathLength={100} />
                  </>
                ) : null}
                {pulse > 0 && i + 1 === activeIndex ? <path key={pulse} className={styles.comet} d={seg.d} pathLength={100} /> : null}
                {handoffs.items.map((hf, k) =>
                  hf.to === i + 1 ? (
                    <g key={`${handoffs.id}-${hf.to}`} data-tone={hf.tone}>
                      {/* Relevo: la vía se dibuja de luz desde la etapa anterior hasta la que se enciende. */}
                      <path className={styles.handoff} d={seg.d} pathLength={100} style={delay(k)} />
                      <path className={styles.handoffHead} d={seg.d} pathLength={100} style={delay(k)} />
                    </g>
                  ) : null,
                )}
                {i === gateIndex ? <path className={styles.gate} d={`M${seg.mid.x} ${seg.mid.y - 10}l10 10-10 10-10-10z`} /> : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      <ol ref={ref} className={styles.pipeline}>
        {view.stages.map((stage, i) => {
          const state = states[i];
          const active = i === activeIndex;
          const hasGate = i === gateIndex;
          const responsible = STAGE_RESPONSIBLE[stage.id];
          const phase = i % STAGES_PER_ROW === 0 ? PIPELINE_PHASES[i / STAGES_PER_ROW] : null;
          return (
            <li key={stage.id} data-cell="" className={styles.station} data-state={state} data-active={active ? "" : undefined} data-phase={phase ? "" : undefined}>
              {phase ? <span className={styles.phase}>{phase}</span> : null}
              <button type="button" className={styles.button} aria-haspopup="dialog" onClick={() => onOpen(stage.id)}>
                <span className={styles.nodeWrap} data-node="">
                  {active || state === "awaiting" ? <span className={styles.pool} /> : null}
                  {pulse > 0 && active && i === 0 ? <span key={pulse} className={styles.flash} /> : null}
                  {/* La primera etapa no tiene tramo de entrada: su carga es un anillo que se repite. */}
                  {active && i === 0 ? <span className={`${styles.flash} ${styles.flashLoop}`} /> : null}
                  {handoffs.items.map((hf, k) =>
                    hf.to === i ? <span key={`${handoffs.id}-${hf.to}`} className={styles.ignite} data-tone={hf.tone} style={delay(k, HANDOFF_MS * 0.55)} /> : null,
                  )}
                  <StageNode state={state} />
                  {showsAvatar(stage.id) && state !== "awaiting" ? (
                    <span className={styles.avatar}>
                      <AgentAvatar kind={responsible.kind} size={26} active={active} />
                    </span>
                  ) : null}
                </span>
                <span className={styles.text}>
                  <span className={styles.number}>{String(i + 1).padStart(2, "0")}</span>
                  <span className={styles.label}>{stage.label}</span>
                  <span className={styles.state}>{stateLabel(state, view)}</span>
                  <span className={styles.agent}>{responsible.name}</span>
                  {hasGate ? <span className={styles.gateText}>Después: espera tu decisión ({approvalKindLabel(view.pendingApproval.kind)})</span> : null}
                </span>
              </button>
              {i === decisionIndex && decision ? (
                <button type="button" className={styles.decide} onClick={decision.onReview} disabled={decision.busy} aria-haspopup="dialog">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M7 1l6 6-6 6-6-6z" />
                  </svg>
                  {decision.busy ? "Registrando tu decisión…" : `Revisar y decidir: ${approvalKindLabel(view.pendingApproval.kind)}`}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
