import { Link } from "react-router";
import type { ExecutionView, ProposalHistoryItem, ProposalStatus } from "../api/types";
import { useDecisionHistory, useProposalHistory } from "../hooks/useDecisions";
import { describeOutcome, type OutcomeTone } from "../model/outcomes";
import { approvalKindLabel, stateLabel, stationState, type StationState } from "../model/stages";
import { StageMark } from "./StageMark";
import styles from "./ExecutionResult.module.css";

const TONE_MARK: Record<OutcomeTone, StationState> = { success: "done", warning: "awaiting", failure: "failed", stopped: "skipped" };
const VERB = { approve: "aprobó", reject: "rechazó", request_changes: "pidió cambios en" } as const;
const PROPOSAL_STATUS: Record<ProposalStatus, string> = {
  pending: "Pendiente de aprobación",
  approved: "Aprobada",
  rejected: "Rechazada",
  changes_requested: "Cambios pedidos",
  rejected_by_review: "Rechazada por una revisión automática",
  current: "Vigente, sin decisión",
  superseded: "Reemplazada",
};
const timeFormat = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "medium" });
const withPeriod = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const short = (h: string) => (h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h);
const when = (iso: string) => timeFormat.format(Date.parse(iso));

function FileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className={styles.fileGroup}>
      <h4 className={styles.small}>
        {title} ({files.length})
      </h4>
      {files.length === 0 ? (
        <p className={styles.muted}>Ninguno.</p>
      ) : (
        <ul className={styles.files}>
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Versión cuyos archivos resumen el resultado: la aplicada, la aprobada o, si no, la última. */
function mainProposal(ps: ProposalHistoryItem[]): ProposalHistoryItem | undefined {
  return ps.find((p) => p.applied) ?? ps.findLast((p) => p.status === "approved") ?? ps.at(-1);
}

/** Resumen de una ejecución terminada, solo con datos de la API (incluido el historial inmutable). */
export function ExecutionResult({ view }: { view: ExecutionView }) {
  const outcome = describeOutcome(view.finalResult.outcome);
  const proposals = useProposalHistory(view.executionId);
  const decisions = useDecisionHistory(view.executionId);
  const stage = (id: string) => view.stages.find((s) => s.id === id);
  const apply = stage("apply");
  const verify = stage("verify");
  const reviews = view.stages.filter((s) => s.id === "functional_review" || s.id === "quality_review");
  const main = proposals.data ? mainProposal(proposals.data) : undefined;

  return (
    <section className={styles.panel} aria-labelledby="result-title" data-tone={outcome.tone}>
      <header className={styles.head}>
        <StageMark state={TONE_MARK[outcome.tone]} size={24} />
        <div className={styles.headText}>
          <h2 id="result-title" className={styles.title}>
            Resultado final
          </h2>
          <p className={styles.outcome}>{outcome.text}</p>
          <p className={styles.muted}>
            Fase <code>{view.finalResult.outcome ?? view.phase}</code>.
            {view.finalResult.detail ? <> Detalle del backend: {withPeriod(view.finalResult.detail)}</> : null}
          </p>
        </div>
      </header>

      {/* Datos cortos como indicadores; las revisiones, que son texto largo, a ancho completo. */}
      <ul className={styles.indicators} aria-label="Aplicación y verificación">
        {[apply, verify].map((s) =>
          s ? (
            <li key={s.id} className={styles.indicator} data-state={stationState(s, view)}>
              <span className={styles.indicatorLabel}>{s.label}</span>
              <span className={styles.indicatorValue}>
                <StageMark state={stationState(s, view)} size={14} />
                {stateLabel(stationState(s, view), view)}
              </span>
            </li>
          ) : null,
        )}
        {view.applyTarget ? (
          <li className={styles.indicator}>
            <span className={styles.indicatorLabel}>Aplicado en</span>
            <span className={styles.indicatorValue}>
              {view.project && view.applyTarget === view.project.rootPath ? "Repositorio real" : "Sandbox de esta ejecución"}
            </span>
          </li>
        ) : null}
        <li className={styles.indicator}>
          <span className={styles.indicatorLabel}>Ciclos de corrección</span>
          <span className={styles.indicatorValue}>{view.retries}</span>
        </li>
      </ul>
      {[apply, verify].some((s) => s?.detail) || view.applyTarget ? (
        <div className={styles.indicatorNotes}>
          {[apply, verify].map((s) =>
            s?.detail ? (
              <p key={s.id} className={styles.muted}>
                {s.label}: {withPeriod(s.detail)}
              </p>
            ) : null,
          )}
          {view.applyTarget ? <p className={styles.path}>{view.applyTarget}</p> : null}
        </div>
      ) : null}

      <section aria-labelledby="res-reviews">
        <h3 id="res-reviews" className={styles.heading}>
          Revisiones
        </h3>
        <ul className={styles.reviews}>
          {reviews.map((r) => (
            <li key={r.id} className={styles.review}>
              <span className={styles.reviewHead}>
                <span className={styles.reviewName}>{r.label}</span>
                <span className={styles.verdict} data-state={stationState(r, view)}>
                  <StageMark state={stationState(r, view)} size={12} />
                  {stateLabel(stationState(r, view), view)}
                </span>
              </span>
              <span className={styles.prose}>{r.detail ?? "Sin resumen registrado por el backend."}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="res-decisions">
        <h3 id="res-decisions" className={styles.heading}>
          Decisiones humanas
        </h3>
        {decisions.isPending ? (
          <p className={styles.muted}>Cargando decisiones…</p>
        ) : decisions.isError ? (
          <p className={styles.errorText}>No se pudieron cargar las decisiones: {decisions.error.message}</p>
        ) : decisions.data.length === 0 ? (
          <p className={styles.muted}>Ninguna registrada.</p>
        ) : (
          <ol className={styles.plain}>
            {decisions.data.map((d) => (
              <li key={d.id}>
                <span>
                  {d.actor} {VERB[d.decision]} la {approvalKindLabel(d.kind)}
                  {d.feedback ? <>: «{d.feedback}»</> : null}
                </span>
                <span className={styles.muted}>
                  {when(d.resolvedAt)}. Versión <code title={d.subjectHash}>{short(d.subjectHash)}</code>. Fase después:{" "}
                  <code>{d.phaseAfter}</code>.{d.source === "events" ? " Reconstruida de eventos antiguos: sin observaciones." : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="res-files">
        <h3 id="res-files" className={styles.heading}>
          Archivos
        </h3>
        {proposals.isPending ? (
          <p className={styles.muted}>Cargando propuestas…</p>
        ) : proposals.isError ? (
          <p className={styles.errorText}>No se pudo cargar el historial de propuestas: {proposals.error.message}</p>
        ) : main === undefined ? (
          <p className={styles.muted}>
            Ninguna propuesta: la ejecución terminó antes del desarrollo.
            {outcome.tone === "stopped" ? " No se aplicó nada." : ""}
          </p>
        ) : (
          <>
            <div className={styles.fileGrid}>
              <FileList title="Crear" files={main.filesToCreate} />
              <FileList title="Modificar" files={main.filesToModify} />
              <FileList title="Eliminar" files={main.filesToDelete} />
            </div>
            <p className={styles.muted}>
              Versión {main.version} (<code title={main.proposalHash}>{short(main.proposalHash)}</code>):{" "}
              {PROPOSAL_STATUS[main.status].toLowerCase()}
              {main.applied ? ", aplicada" : ""}.
            </p>
          </>
        )}
      </section>

      {proposals.data && proposals.data.length > 1 ? (
        <section aria-labelledby="res-versions">
          <h3 id="res-versions" className={styles.heading}>
            Historial de propuestas ({proposals.data.length})
          </h3>
          <ol className={styles.plain}>
            {proposals.data.map((p) => (
              <li key={p.id}>
                <span>
                  Versión {p.version}: {PROPOSAL_STATUS[p.status]}
                  {p.applied ? ", aplicada" : ""}
                </span>
                <span className={styles.muted}>
                  <code title={p.proposalHash}>{short(p.proposalHash)}</code>. {p.summary}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {view.errors.length > 0 ? (
        <section aria-labelledby="res-errors" className={styles.errors}>
          <h3 id="res-errors" className={styles.heading}>
            Errores registrados
          </h3>
          <ul>
            {view.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.sessionId !== "unavailable" ? (
        <p className={styles.muted}>
          La conversación completa está en la <Link to={`/sessions/${encodeURIComponent(view.sessionId)}`}>sesión</Link>.
        </p>
      ) : null}
    </section>
  );
}
