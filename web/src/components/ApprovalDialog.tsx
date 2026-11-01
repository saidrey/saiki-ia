import { useEffect, useId, useRef, useState } from "react";
import type { ApprovalResponse, ExecutionStage, ExecutionView } from "../api/types";
import { useApproval, useDecide } from "../hooks/useDecisions";
import { useNow } from "../hooks/useNow";
import { decisionOptions, describeDecisionError, shownHash, type DecisionOption } from "../model/decisions";
import { elapsed } from "../model/format";
import { approvalKindLabel } from "../model/stages";
import { applyDestination, executionProjectNotices } from "../model/projects";
import { FeasibilityContent, HuContent, ProposalContent } from "./ApprovalContent";
import { StageMark } from "./StageMark";
import styles from "./ApprovalDialog.module.css";

interface Props {
  executionId: string;
  open: boolean;
  onClose: () => void;
  /** Etapas de revisión (funcional y de calidad) para la decisión final. */
  reviews: ExecutionStage[];
  /** Proyecto de la ejecución: dónde se aplicará y si aplicar se bloqueará. */
  project: ExecutionView["project"];
}

/**
 * Diálogo modal de decisión humana. Muestra la versión que la API entrega y la
 * CONGELA mientras está abierto: si llega otra versión, se avisa en lugar de
 * cambiarla bajo el cursor. La decisión se envía con el hash de lo mostrado.
 */
export function ApprovalDialog({ executionId, open, onClose, reviews, project }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const q = useApproval(executionId, open);
  const decide = useDecide();
  const [shown, setShown] = useState<ApprovalResponse | null>(null);
  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DecisionOption | null>(null);
  const now = useNow(decide.isPending);

  // Momento de apertura: lo que hubiera en caché puede ser de la decisión anterior.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  if (open && openedAt === null) setOpenedAt(Date.now());
  if (!open && openedAt !== null) setOpenedAt(null);
  // Congela la primera versión recibida DESPUÉS de abrir; se libera al cerrar.
  if (open && shown === null && q.data && openedAt !== null && q.dataUpdatedAt >= openedAt) setShown(q.data);
  if (!open && shown !== null) {
    setShown(null);
    setConfirming(null);
    setFeedbackError(null);
  }

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      // Una decisión anterior ya registrada no cuenta para esta.
      if (!decide.isPending) decide.reset();
      d.showModal();
      titleRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Al pedir confirmación, el botón pulsado desaparece: llevar el foco a "Volver"
  // (opción segura: un Enter repetido no confirma algo irreversible).
  useEffect(() => {
    if (confirming !== null) backRef.current?.focus();
  }, [confirming]);

  const current = q.data;
  const changed = shown !== null && current !== undefined && shownHash(current) !== shownHash(shown);
  const stillPending = current?.pendingApproval.required !== false;
  const kind = shown?.pendingApproval.kind;
  const options = shown ? decisionOptions(shown) : [];
  const hash = shown ? shownHash(shown) : undefined;
  const busy = decide.isPending;
  const finished = decide.isSuccess;

  function submit(option: DecisionOption) {
    if (shown === null || hash === undefined || kind === undefined) return;
    const text = feedback.trim();
    if (option.needsFeedback && text.length === 0) {
      setFeedbackError("Escribe qué cambios pides: es lo que recibirá el agente.");
      return;
    }
    if (option.confirm && confirming?.decision !== option.decision) {
      setConfirming(option);
      return;
    }
    setConfirming(null);
    setFeedbackError(null);
    decide.mutate(
      { executionId, kind, decision: option.decision, hash, feedback: text || undefined },
      {
        onSuccess: () => setFeedback(""),
      },
    );
    // La API responde al llegar a la siguiente puerta (puede tardar minutos): se cierra ya para ver
    // el avance en el pipeline. Un error se muestra en la página (con el diálogo cerrado).
    onClose();
  }

  const error = decide.error ? describeDecisionError(decide.error) : null;
  const title = approvalKindLabel(kind ?? current?.pendingApproval.kind);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className={styles.head}>
        <StageMark state="awaiting" size={22} />
        <div className={styles.headText}>
          <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1} className={styles.title}>
            {title}
          </h2>
          <p className={styles.muted}>Lee la versión y decide. Nada avanza hasta que lo hagas.</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose}>
          {busy ? "Seguir en segundo plano" : "Cerrar sin decidir"}
        </button>
      </header>

      <div className={styles.body}>
        {shown === null ? (
          q.isError ? (
            <p className={styles.errorText} role="alert">
              No se pudo cargar la aprobación: {q.error.message}
            </p>
          ) : (
            <p className={styles.muted}>Cargando la versión pendiente…</p>
          )
        ) : (
          <>
            {changed && !finished ? (
              <div className={styles.notice} role="alert">
                <p>
                  {stillPending
                    ? "Hay una versión distinta de la que estás viendo. Tu decisión solo valdría para la versión vigente."
                    : "Esta ejecución ya no espera esta decisión."}
                </p>
                {stillPending ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => {
                      setShown(current ?? null);
                      setConfirming(null);
                      decide.reset();
                    }}
                  >
                    Ver la versión vigente
                  </button>
                ) : null}
              </div>
            ) : null}

            {kind === "hu_review" && shown.gate?.kind === "hu_review" ? (
              <HuContent gate={shown.gate} />
            ) : kind === "feasibility_partial" && shown.gate?.kind === "feasibility_partial" ? (
              <FeasibilityContent gate={shown.gate} />
            ) : kind === "final_approval" && shown.proposal !== null ? (
              <ProposalContent proposal={shown.proposal} reviews={reviews} />
            ) : (
              <p className={styles.muted}>
                La API no devolvió el contenido de esta aprobación ({kind ?? "sin tipo"}). No se puede decidir desde aquí.
              </p>
            )}

            {kind === "final_approval" && applyDestination({ project }) ? (
              <div className={styles.destination} data-mode={applyDestination({ project })?.mode}>
                <span className={styles.muted}>Destino si apruebas</span>
                <p>{applyDestination({ project })?.text}</p>
              </div>
            ) : null}
            {executionProjectNotices({ project })
              .filter((n) => n.tone === "blocked")
              .map((n) => (
                <div key={n.text} className={styles.notice}>
                  <p>{n.text}</p>
                </div>
              ))}

            {hash ? (
              <div className={styles.hash}>
                <span className={styles.muted}>Versión que decides</span>
                <code title={hash}>{`${hash.slice(0, 12)}…${hash.slice(-6)}`}</code>
              </div>
            ) : null}

            {options.length > 0 ? (
              <div className={styles.field}>
                <label htmlFor={`${id}-fb`} className={styles.label}>
                  Observaciones
                </label>
                <span id={`${id}-fb-help`} className={styles.muted}>
                  Obligatorias para pedir cambios; opcionales en el resto. Quedan registradas con tu decisión.
                </span>
                <textarea
                  id={`${id}-fb`}
                  rows={3}
                  className={styles.textarea}
                  value={feedback}
                  readOnly={busy}
                  aria-describedby={`${id}-fb-help${feedbackError ? ` ${id}-fb-err` : ""}`}
                  aria-invalid={feedbackError ? true : undefined}
                  onChange={(e) => {
                    setFeedback(e.target.value);
                    setFeedbackError(null);
                  }}
                />
                {feedbackError ? (
                  <span id={`${id}-fb-err`} className={styles.errorText}>
                    {feedbackError}
                  </span>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <div className={styles.errorBox} role="alert">
                <p className={styles.errorTitle}>{error.title}</p>
                <p>{error.text}</p>
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className={styles.foot}>
        {busy ? (
          <p className={styles.progress} role="status">
            Decisión enviada. Saiki-IA está trabajando ({elapsed(now - decide.submittedAt)}); con agentes reales puede
            tardar minutos.
          </p>
        ) : confirming ? (
          <div className={styles.confirm} role="alert">
            <p>{confirming.confirm}</p>
            <div className={styles.actions}>
              <button ref={backRef} type="button" className={styles.secondary} onClick={() => setConfirming(null)}>
                Volver
              </button>
              <button type="button" className={styles[confirming.tone]} onClick={() => submit(confirming)}>
                Confirmar: {confirming.label.toLowerCase()}
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className={styles.muted}>El servidor registra quién decide.</span>
            <div className={styles.actions}>
              {options
                .toReversed()
                .map((o) => (
                  <button
                    key={o.decision}
                    type="button"
                    className={styles[o.tone]}
                    disabled={!stillPending || (changed && !finished) || shown === null}
                    onClick={() => submit(o)}
                  >
                    {o.label}
                  </button>
                ))}
            </div>
          </>
        )}
      </footer>
    </dialog>
  );
}
