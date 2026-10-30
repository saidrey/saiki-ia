import type { StationState } from "../model/stages";
import styles from "./StageMark.module.css";

/**
 * Marcador de estado de una etapa. Cada estado tiene FORMA propia (no solo
 * color): check, anillo con núcleo, rombo de señal, aspa, anillo, anillo
 * discontinuo tachado, punto. Decorativo: el texto del estado va aparte.
 */
export function StageMark({ state, live = false, size = 28 }: { state: StationState; live?: boolean; size?: number }) {
  return (
    <svg
      className={styles.mark}
      data-state={state}
      data-live={live && state === "running" ? "" : undefined}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      {state === "done" ? (
        <>
          <circle className={styles.fill} cx="14" cy="14" r="12" />
          <path className={styles.ink} d="M8.5 14.5l3.5 3.5 7.5-8" />
        </>
      ) : state === "running" ? (
        <>
          <circle className={styles.ring} cx="14" cy="14" r="11" />
          <circle className={styles.core} cx="14" cy="14" r="5" />
        </>
      ) : state === "awaiting" ? (
        <>
          <path className={styles.fill} d="M14 1.5L26.5 14 14 26.5 1.5 14z" />
          <path className={styles.ink} d="M11.25 10v8M16.75 10v8" />
        </>
      ) : state === "failed" ? (
        <>
          <circle className={styles.fill} cx="14" cy="14" r="12" />
          <path className={styles.ink} d="M10 10l8 8M18 10l-8 8" />
        </>
      ) : state === "skipped" ? (
        <>
          <circle className={styles.dashed} cx="14" cy="14" r="10" />
          <path className={styles.slash} d="M9 19L19 9" />
        </>
      ) : state === "not_applicable" ? (
        <circle className={styles.dot} cx="14" cy="14" r="3" />
      ) : (
        <circle className={styles.hollow} cx="14" cy="14" r="10" />
      )}
    </svg>
  );
}
