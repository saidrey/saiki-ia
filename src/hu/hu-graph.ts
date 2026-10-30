import {
  StateGraph,
  START,
  END,
  interrupt,
  Command,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { createSqliteCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter, type AgentRouter } from "../agents/router.js";
import { ClaudeCliAdapter } from "../agents/claude-cli-agent.js";
import { KiroCliAdapter } from "../agents/kiro-cli-agent.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { analyzeHu, reviseHu } from "./hu-analyst.js";
import { analyzeTechnical } from "../tech/tech-analyst.js";
import { classifyFeasibility } from "../dev/feasibility.js";
import { developProposal } from "../dev/dev-analyst.js";
import { hashDevProposal, type DevContext, type DevProposal } from "../dev/dev-schema.js";
import { runFunctionalReview, runQualityReview } from "../reviewers/reviewers.js";
import { applyDevProposal } from "../apply/dev-proposal-bridge.js";
import { verifyAppliedProposal, type RunProjectChecks } from "../apply/verify-applied.js";
import {
  HuState,
  MAX_HU_REVISIONS,
  MAX_REVIEW_CYCLES,
  type HuStateType,
  type HuUpdate,
  type ApplicationAudit,
} from "./hu-state.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolveSafePath } from "../apply/path-validation.js";

/** Restricciones arquitectónicas conocidas que Claude debe respetar (Fase 11). */
const PROJECT_CONSTRAINTS: string[] = [
  "No introducir frontend, servidor HTTP, WebSocket ni UI sin aprobación explícita.",
  "No agregar dependencias innecesarias ni frameworks nuevos sin justificación.",
  "No ampliar el alcance de la HU por iniciativa propia.",
  "No eliminar funcionalidades existentes para simplificar.",
  "Mantener KISS/YAGNI. Los agentes son genéricos (sin skills/perfiles de empresa).",
];

/**
 * (Project Registry) De dónde sale el repositorio de cada ejecución.
 *  - Con proyecto vinculado (`state.project`): su ruta, siempre.
 *  - Sin proyecto: el `rootDir` del grafo, SOLO si `requireProject` es false
 *    (uso directo del grafo: pruebas y scripts manuales). El Core lo construye
 *    con `requireProject: true`: sin proyecto no se lee, desarrolla ni aplica.
 */
interface RootPolicy {
  fallbackRoot: string;
  requireProject: boolean;
}

const NO_PROJECT =
  "La ejecución no tiene un proyecto vinculado: no se trabaja sobre ningún repositorio sin identificarlo. Requiere intervención humana.";

/** Repositorio de ESTA ejecución, o null si no puede identificarse. */
function rootOf(state: HuStateType, policy: RootPolicy): string | null {
  if (state.project) return state.project.rootPath;
  return policy.requireProject ? null : policy.fallbackRoot;
}

/**
 * (Project Registry) Guardia previa a la escritura. Se ejecuta en `applyTask`
 * inmediatamente antes de escribir: valida la vinculación de la ejecución y
 * devuelve el directorio donde aplicar (repo real o sandbox de la ejecución).
 * Si falla, el nodo termina en `apply_blocked` sin escribir nada.
 */
export type ApplyGuard = (input: {
  executionId: string;
  state: HuStateType;
}) => { ok: true; applyDir: string } | { ok: false; reason: string };

/** Directorios que ninguna propuesta puede tocar, en ningún proyecto. */
const PROTECTED_DIRS = [".git", ".saiki"];

function touchesProtectedDir(p: DevProposal): string | null {
  for (const ch of p.changes) {
    const first = ch.path.split(/[/\\]/).find((seg) => seg !== "" && seg !== ".");
    if (first !== undefined && PROTECTED_DIRS.includes(first)) return ch.path;
  }
  return null;
}

/**
 * Grafo del flujo de HU (Fase 9), INDEPENDIENTE del pipeline develop/review.
 *
 * Flujo:
 *   START -> generateHuTask
 *     - fallo (agente/validacion) -> END (phase="failed", sin fallback)
 *     - ok -> approvalTask [interrupt(): revision humana de la HU]
 *         - approve -> END (phase="approved", HU guardada en el estado)
 *         - reject  -> END (phase="rejected")
 *         - revise + feedback:
 *              - quedan revisiones -> generateHuTask (nueva version con feedback)
 *              - sin cupo           -> END (phase="revision_limit")
 *
 * Reutiliza: AgentRouter (rol huAnalyst = Kiro CLI), checkpointer SQLite,
 * patron interrupt/resume con el mismo thread_id.
 */

/** Nodo: genera (o regenera) la HU. */
function makeGenerateHu(router: AgentRouter, policy: RootPolicy) {
  return async function generateHu(state: HuStateType): Promise<HuUpdate> {
    const root = rootOf(state, policy);
    if (root === null) return { phase: "failed", error: NO_PROJECT, hu: null };
    // Si ya hay una HU previa y venimos de una revision, usamos el ultimo
    // feedback para regenerar; si no, analisis inicial.
    const lastDecision = state.decisions[state.decisions.length - 1];
    const isRevision = state.hu !== null && lastDecision?.action === "revise";

    const result =
      isRevision && state.hu
        ? await reviseHu(router, state.hu, lastDecision.feedback ?? "", root)
        : await analyzeHu(router, state.request, root);

    if (!result.ok) {
      return { phase: "failed", error: result.error, hu: null };
    }

    return {
      hu: result.hu,
      versions: [result.hu],
      phase: "pending_review",
      // Cada regeneracion cuenta como una revision (salvo la inicial).
      revisions: isRevision ? 1 : 0,
    };
  };
}

/**
 * Nodo: aprobacion humana de la HU. PAUSA con interrupt y expone la propuesta.
 * Decisiones: approve | reject | revise (con feedback). Ausencia NO aprueba.
 */
function approvalGate(state: HuStateType): HuUpdate {
  const decision = interrupt({
    kind: "hu_review",
    summary: state.hu?.summary,
    hu: state.hu,
    revisionsUsed: state.revisions,
    maxRevisions: MAX_HU_REVISIONS,
  }) as { action?: string; feedback?: string } | string;

  const action = typeof decision === "string" ? decision : decision?.action;
  const feedback = typeof decision === "string" ? undefined : decision?.feedback;

  if (action === "approve") {
    return { phase: "approved", decisions: [{ action: "approve" }] };
  }
  if (action === "revise") {
    // Si ya se agoto el limite, no se revisa mas: termina explicitamente.
    if (state.revisions >= MAX_HU_REVISIONS) {
      return { phase: "revision_limit", decisions: [{ action: "revise", feedback }] };
    }
    return { phase: "none", decisions: [{ action: "revise", feedback }] };
  }
  // Todo lo que no sea approve/revise explicito es rechazo.
  return { phase: "rejected", decisions: [{ action: "reject" }] };
}

/**
 * Nodo (Fase 10): análisis técnico. Se ejecuta SOLO cuando la HU fue aprobada.
 * Produce un análisis estructurado y validado (rutas verificadas en disco).
 * Solo lectura; no modifica código. Fallo -> ruta de error explícita.
 */
function makeTechnicalAnalysis(router: AgentRouter, policy: RootPolicy) {
  return async function technicalAnalysis(state: HuStateType): Promise<HuUpdate> {
    if (state.hu === null || state.phase !== "approved") {
      // Defensa: no debería llegar aquí sin HU aprobada.
      return { phase: "tech_failed", error: "No hay HU aprobada para analizar." };
    }
    const rootDir = rootOf(state, policy);
    if (rootDir === null) return { phase: "tech_failed", error: NO_PROJECT };

    const result = await analyzeTechnical(router, state.hu, rootDir);
    if (!result.ok) {
      return { phase: "tech_failed", error: result.error };
    }

    return {
      phase: "tech_analyzed",
      technicalAnalysis: result.analysis,
      unresolvedPaths: result.unresolvedPaths,
    };
  };
}

/**
 * Nodo (Fase 11): clasifica la viabilidad a partir del CONTENIDO del análisis.
 * No ejecuta Claude. Deriva feasibility (ready/blocked/partially_ready).
 */
function classifyTask(state: HuStateType): HuUpdate {
  if (state.technicalAnalysis === null || state.phase !== "tech_analyzed") {
    return { phase: "tech_failed", error: "No hay análisis técnico que clasificar." };
  }
  const { feasibility, reasons } = classifyFeasibility(
    state.technicalAnalysis,
    state.unresolvedPaths,
  );
  return { feasibility, feasibilityReasons: reasons };
}

/**
 * Nodo (Fase 11): decisión humana para `partially_ready`. PAUSA con interrupt.
 * El usuario decide: proceder con lo implementable (proceed), ajustar la HU
 * (revise -> re-análisis) o abandonar (reject). NO se implementa nada pendiente
 * de decisión por iniciativa propia.
 */
function partialDecisionGate(state: HuStateType): HuUpdate {
  const decision = interrupt({
    kind: "feasibility_partial",
    feasibility: state.feasibility,
    reasons: state.feasibilityReasons,
    technicalAnalysis: state.technicalAnalysis,
  }) as { action?: string } | string;
  const action = typeof decision === "string" ? decision : decision?.action;

  if (action === "proceed") return { phase: "tech_analyzed" }; // procede a develop
  // Cualquier otra cosa detiene el flujo sin desarrollar.
  return { phase: "blocked", error: "Decisión humana: no proceder con partially_ready." };
}

/**
 * Nodo (Fase 11): desarrollador. Arma el DevContext DESDE el estado (fuente
 * única) y pide a Claude una propuesta. Valida y calcula el hash. Claude NO
 * escribe. Fallo/invalido -> dev_failed (sin fallback).
 */
function makeDevelop(router: AgentRouter, policy: RootPolicy) {
  return async function develop(state: HuStateType): Promise<HuUpdate> {
    if (state.hu === null || state.technicalAnalysis === null) {
      return { phase: "dev_failed", error: "Falta HU o análisis técnico para desarrollar." };
    }
    const rootDir = rootOf(state, policy);
    if (rootDir === null) return { phase: "dev_failed", error: NO_PROJECT };
    if (state.feasibility !== "ready" && state.feasibility !== "partially_ready") {
      // Defensa: nunca desarrollar si no está habilitado.
      return { phase: "dev_failed", error: `Viabilidad no habilita desarrollo: ${state.feasibility}.` };
    }

    const ctx: DevContext = {
      hu: {
        version: state.versions.length,
        summary: state.hu.summary,
        need: state.hu.need,
        tasks: state.hu.tasks,
        acceptanceCriteria: state.hu.acceptanceCriteria,
        assumptions: state.hu.assumptions,
        openQuestions: state.hu.openQuestions,
      },
      technical: {
        summary: state.technicalAnalysis.summary,
        currentFlow: state.technicalAnalysis.currentFlow,
        affectedFiles: state.technicalAnalysis.affectedFiles,
        proposedChanges: state.technicalAnalysis.proposedChanges,
        dependencies: state.technicalAnalysis.dependencies,
        risks: state.technicalAnalysis.risks,
        openQuestions: state.technicalAnalysis.openQuestions,
      },
      feasibility: state.feasibility,
      feasibilityReasons: state.feasibilityReasons,
      constraints: PROJECT_CONSTRAINTS,
      // (Fase 12) Si venimos de un rechazo de revisión, pasamos los cambios
      // requeridos pendientes para que esta versión los corrija.
      reviewFindings: pendingReviewFindings(state),
    };

    const result = await developProposal(router, ctx, rootDir);
    if (!result.ok) {
      return { phase: "dev_failed", error: result.error };
    }

    // Nueva propuesta => hash nuevo => las aprobaciones de revisión previas
    // quedan OBSOLETAS (se vacían). Se re-revisará desde funcional.
    return {
      phase: "dev_proposed",
      devProposal: result.proposal,
      devProposalHash: hashDevProposal(result.proposal),
      devNewFiles: result.newFiles,
      devExistingFiles: result.existingFiles,
      devUnverifiablePaths: result.unverifiablePaths,
      functionalApprovedHash: "",
      qualityApprovedHash: "",
    };
  };
}

/** Reúne los cambios requeridos pendientes de las revisiones (para corregir). */
function pendingReviewFindings(state: HuStateType): string[] {
  const out: string[] = [];
  if (state.functionalReview && state.functionalReview.decision === "rejected") {
    out.push(...state.functionalReview.requiredChanges.map((c) => `[funcional] ${c}`));
  }
  if (state.qualityReview && state.qualityReview.decision === "rejected") {
    out.push(...state.qualityReview.requiredChanges.map((c) => `[calidad] ${c}`));
  }
  return out;
}

/**
 * Nodo (Fase 12): revisión FUNCIONAL. Evalúa la propuesta contra la HU.
 * - aprobado -> registra functionalApprovedHash = hash actual.
 * - rechazado -> incrementa el ciclo global y devuelve hallazgos a develop.
 * - fallo/invalido -> review_failed (sin fallback).
 */
function makeFunctionalReview(router: AgentRouter, policy: RootPolicy) {
  return async function functionalReview(state: HuStateType): Promise<HuUpdate> {
    if (state.devProposal === null || state.hu === null) {
      return { phase: "review_failed", error: "No hay propuesta/HU para revisión funcional." };
    }
    const root = rootOf(state, policy);
    if (root === null) return { phase: "review_failed", error: NO_PROJECT };
    const result = await runFunctionalReview(router, state.hu, state.devProposal, root);
    if (!result.ok) {
      return { phase: "review_failed", error: result.error };
    }
    const review = result.review;
    const hist = {
      cycle: state.reviewCycles,
      kind: "functional" as const,
      decision: review.decision,
      hash: state.devProposalHash,
      findings: review.findings.length,
    };

    if (review.decision === "approved") {
      return {
        functionalReview: review,
        functionalApprovedHash: state.devProposalHash,
        reviewHistory: [hist],
      };
    }
    // Rechazado: cuenta como un ciclo de corrección.
    return {
      functionalReview: review,
      functionalApprovedHash: "",
      reviewCycles: 1,
      reviewHistory: [hist],
    };
  };
}

/**
 * Nodo (Fase 12): revisión de CALIDAD. Solo corre tras aprobación funcional.
 * - aprobado -> registra qualityApprovedHash = hash actual.
 * - rechazado -> incrementa el ciclo global y devuelve hallazgos a develop.
 * - fallo/invalido -> review_failed.
 */
function makeQualityReview(router: AgentRouter, policy: RootPolicy) {
  return async function qualityReview(state: HuStateType): Promise<HuUpdate> {
    if (state.devProposal === null || state.technicalAnalysis === null) {
      return { phase: "review_failed", error: "No hay propuesta/análisis para revisión de calidad." };
    }
    const root = rootOf(state, policy);
    if (root === null) return { phase: "review_failed", error: NO_PROJECT };
    const result = await runQualityReview(
      router,
      state.devProposal,
      state.technicalAnalysis,
      PROJECT_CONSTRAINTS,
      state.functionalReview?.findings ?? [],
      root,
    );
    if (!result.ok) {
      return { phase: "review_failed", error: result.error };
    }
    const review = result.review;
    const hist = {
      cycle: state.reviewCycles,
      kind: "quality" as const,
      decision: review.decision,
      hash: state.devProposalHash,
      findings: review.findings.length,
    };

    if (review.decision === "approved") {
      return {
        qualityReview: review,
        qualityApprovedHash: state.devProposalHash,
        reviewHistory: [hist],
      };
    }
    return {
      qualityReview: review,
      qualityApprovedHash: "",
      reviewCycles: 1,
      reviewHistory: [hist],
    };
  };
}

/**
 * Nodo (Fase 12): verificación de que AMBAS revisiones aprobaron EXACTAMENTE la
 * misma versión (el hash actual). Es la invariante del PO. Si se cumple ->
 * reviews_passed (pasa a aprobación humana). Si no, es un error de flujo.
 */
function gateBothReviews(state: HuStateType): HuUpdate {
  const h = state.devProposalHash;
  if (h !== "" && state.functionalApprovedHash === h && state.qualityApprovedHash === h) {
    return { phase: "reviews_passed" };
  }
  // Defensa: no debería llegar aquí sin ambas aprobaciones del mismo hash.
  return { phase: "review_failed", error: "Las revisiones no aprobaron la misma versión." };
}

/**
 * Nodo (Fase 12): límite global de ciclos agotado. NO aprueba automáticamente.
 * Deja el estado con todos los hallazgos/historial para decisión humana.
 */
function reviewsExhausted(_state: HuStateType): HuUpdate {
  return {
    phase: "reviews_exhausted",
    error: `Límite de ${MAX_REVIEW_CYCLES} ciclos de corrección alcanzado sin aprobación de ambas revisiones.`,
  };
}

/** Separa los cambios de la propuesta por tipo de operación (para el resumen). */
function splitChanges(p: DevProposal | null): {
  created: string[];
  modified: string[];
  deleted: string[];
} {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const ch of p?.changes ?? []) {
    if (ch.operation === "create") created.push(ch.path);
    else if (ch.operation === "modify") modified.push(ch.path);
    else deleted.push(ch.path);
  }
  return { created, modified, deleted };
}

/**
 * Nodo (Fase 13): APROBACIÓN HUMANA FINAL. PAUSA con interrupt y presenta al
 * humano TODO lo necesario para decidir: resumen, archivos a crear/modificar/
 * eliminar, resultados de ambas revisiones, riesgos y el hash SHA-256 exacto.
 *
 * Decisiones: approve | reject | request_changes.
 *  - approve         -> ready_to_apply, fija finalApprovedHash = hash actual.
 *  - reject          -> final_approval_rejected (definitivo, NO se aplica).
 *  - request_changes -> vuelve a develop (re-revisa ambas); NO se aplica nada.
 *  - cualquier otra  -> se trata como rechazo. Ausencia NO aprueba.
 *
 * La aprobación queda vinculada al hash EXACTO: si no coincide con el de ambas
 * revisiones, no se autoriza (defensa, no debería ocurrir aquí).
 */
function finalApprovalGate(state: HuStateType): HuUpdate {
  const { created, modified, deleted } = splitChanges(state.devProposal);
  const decision = interrupt({
    kind: "final_approval",
    proposalHash: state.devProposalHash,
    summary: state.devProposal?.summary,
    technicalDecisions: state.devProposal?.technicalDecisions ?? [],
    filesToCreate: created,
    filesToModify: modified,
    filesToDelete: deleted,
    functionalReview: state.functionalReview,
    qualityReview: state.qualityReview,
    risks: state.devProposal?.risks ?? [],
    openQuestions: state.devProposal?.openQuestions ?? [],
    uncoveredCriteria: state.devProposal?.uncoveredCriteria ?? [],
    proposal: state.devProposal,
  }) as { action?: string; feedback?: string } | string;

  const action = typeof decision === "string" ? decision : decision?.action;
  const feedback = typeof decision === "string" ? undefined : decision?.feedback;

  if (action === "approve") {
    const h = state.devProposalHash;
    // Defensa: solo autorizar si el hash aprobado por ambas revisiones coincide
    // con la propuesta actual. No debilita: re-verifica la invariante del PO.
    if (h !== "" && state.functionalApprovedHash === h && state.qualityApprovedHash === h) {
      return {
        phase: "ready_to_apply",
        finalApprovedHash: h,
        decisions: [{ action: "final_approve" }],
      };
    }
    return {
      phase: "final_approval_rejected",
      error: "La aprobación no corresponde al hash de ambas revisiones. No se autoriza.",
      decisions: [{ action: "final_approve_invalid" }],
    };
  }

  if (action === "request_changes") {
    // No se aplica nada: vuelve al desarrollador y se re-revisa.
    return {
      phase: "dev_proposed", // placeholder; routeAfterFinal lo manda a develop
      decisions: [{ action: "request_changes", feedback }],
      // Invalida las aprobaciones: se re-revisará desde funcional.
      functionalApprovedHash: "",
      qualityApprovedHash: "",
      finalApprovedHash: "",
    };
  }

  // Todo lo demás (incl. ausencia explícita) es rechazo definitivo.
  return { phase: "final_approval_rejected", decisions: [{ action: "final_reject" }] };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Calcula los hashes base esperados (contenido ACTUAL en disco) de los archivos
 * que la propuesta MODIFICA o ELIMINA. El aplicador los usa para detectar
 * cambios concurrentes entre la aprobación y la aplicación: si el disco difiere,
 * rechaza sin sobrescribir. Para "create" no se fija base (debe no existir).
 */
function computeExpectedBaseHashes(
  proposal: DevProposal,
  rootDir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ch of proposal.changes) {
    if (ch.operation !== "modify" && ch.operation !== "delete") continue;
    let abs: string;
    try {
      abs = resolveSafePath(rootDir, ch.path);
    } catch {
      continue; // ruta inválida: el aplicador la rechazará de todos modos
    }
    if (existsSync(abs)) out[ch.path] = sha256(readFileSync(abs, "utf8"));
  }
  return out;
}

/**
 * Nodo (Fase 13): APLICACIÓN SEGURA. Único punto donde se escribe el repo, y
 * SOLO a través del aplicador transaccional (vía el puente DevProposal).
 *
 * Secuencia:
 *  1. Defensa: debe venir de ready_to_apply con hashes coherentes.
 *  2. IDEMPOTENCIA: si appliedHash ya == hash de la propuesta -> noop (no
 *     reescribe). Permite recuperar una ejecución reiniciada sin repetir.
 *  3. Detecta cambios concurrentes (expectedBaseHashes del disco actual).
 *  4. Marca applicationId + "applying" ANTES de escribir (rastro de ejecución
 *     interrumpida).
 *  5. Aplica vía applyDevProposal (valida rutas/symlinks, snapshot, rollback).
 *  6. Mapea el outcome a estados del flujo y arma el registro de auditoría.
 */
function makeApply(policy: RootPolicy & { fallbackApplyDir: string; guard?: ApplyGuard }) {
  return function applyNode(state: HuStateType, config?: LangGraphRunnableConfig): HuUpdate {
    const proposal = state.devProposal;
    if (proposal === null || state.phase !== "ready_to_apply") {
      return { phase: "apply_blocked", error: "No hay propuesta aprobada y lista para aplicar." };
    }
    const approved = state.finalApprovedHash;
    const current = hashDevProposal(proposal);
    // Verificación de hash explícita (lo aprobado == lo que se va a aplicar).
    if (approved === "" || approved !== current) {
      return {
        phase: "apply_blocked",
        error: "El hash aprobado no coincide con la propuesta actual. Se requieren nuevas revisiones y aprobación.",
      };
    }
    const protectedPath = touchesProtectedDir(proposal);
    if (protectedPath !== null) {
      return { phase: "apply_blocked", error: `La propuesta toca un directorio protegido (${protectedPath}); no se aplica.` };
    }

    // (Project Registry) Destino de la escritura. Con proyecto (o si el grafo lo
    // exige), SOLO el que devuelve la guardia, evaluada justo ahora. Nunca se
    // busca el repositorio en otra ruta.
    let rootDir: string;
    if (state.project || policy.requireProject) {
      if (!policy.guard) {
        return { phase: "apply_blocked", error: "No hay guardia de aplicación configurada: no se escribe sin validar el proyecto." };
      }
      const executionId = String(config?.configurable?.thread_id ?? "");
      const g = policy.guard({ executionId, state });
      if (!g.ok) return { phase: "apply_blocked", error: g.reason };
      rootDir = g.applyDir;
    } else {
      rootDir = policy.fallbackApplyDir;
    }

    const applicationId = state.applicationId || randomUUID();
    const expectedBaseHashes = computeExpectedBaseHashes(proposal, rootDir);

    const result = applyDevProposal(proposal, {
      rootDir,
      approvedDevHash: approved,
      alreadyAppliedDevHash: state.appliedHash || undefined,
      expectedBaseHashes,
    });

    const { created, modified, deleted } = splitChanges(proposal);
    const audit: ApplicationAudit = {
      applicationId,
      approvedHash: approved,
      functionalDecision: state.functionalReview?.decision ?? "",
      qualityDecision: state.qualityReview?.decision ?? "",
      humanDecision: "approve",
      approvedAt: new Date().toISOString(),
      affectedFiles: [...created, ...modified, ...deleted],
      backupRef: `snapshot-en-memoria:${applicationId}`,
      applyOutcome: result.outcome,
      verificationSummary: "",
      rollbackSummary: (result.report ?? []).join(" | "),
      notes: result.error ? [result.error] : [],
    };

    // Mapea el outcome del aplicador a la fase del flujo. verifyTask refinará
    // "applied" en applied / applied_with_test_failures según la verificación.
    let phase: HuStateType["phase"];
    switch (result.outcome) {
      case "applied":
        phase = "applied"; // provisional; verifyTask confirma el contenido
        break;
      case "noop":
        phase = "applied"; // ya estaba aplicado (idempotencia)
        break;
      case "rolled_back":
        phase = "rolled_back";
        break;
      case "unrecoverable":
        phase = "unrecoverable";
        break;
      default:
        phase = "apply_blocked"; // rejected (hash/ruta/conflicto)
    }

    return {
      phase,
      applicationId,
      applyOutcome: result.outcome,
      applyReport: result.report ?? [],
      appliedFiles: result.applied,
      appliedHash: result.appliedDevHash ?? state.appliedHash,
      auditRecord: audit,
      error: result.error ?? "",
      applyTarget: rootDir,
    };
  };
}

/**
 * Nodo (Fase 13): VERIFICACIÓN POSTERIOR. Solo corre si la aplicación escribió
 * (applied/noop). Compara el disco contra la propuesta aprobada. Si el contenido
 * no coincide, es un fallo (no se finge éxito). Los tests/typecheck del proyecto
 * NO se ejecutan en el grafo por defecto (no determinista); el estado
 * applied_with_test_failures se alcanza solo si se inyecta un runChecks.
 */
function makeVerify(policy: RootPolicy & { fallbackApplyDir: string }, runChecks?: RunProjectChecks) {
  return function verifyNode(state: HuStateType): HuUpdate {
    const proposal = state.devProposal;
    if (proposal === null) {
      return { phase: "unrecoverable", error: "No hay propuesta para verificar." };
    }
    // Se verifica donde se aplicó (lo fijó applyTask), no en una ruta global.
    const rootDir = state.applyTarget || (state.project || policy.requireProject ? "" : policy.fallbackApplyDir);
    if (rootDir === "") return { phase: "unrecoverable", error: "No consta dónde se aplicó la propuesta." };

    const verification = verifyAppliedProposal(proposal, rootDir, runChecks);

    const audit: ApplicationAudit | null = state.auditRecord
      ? {
          ...state.auditRecord,
          verificationSummary: verification.filesMatch
            ? "contenido coincide con la propuesta aprobada"
            : `discrepancias: ${verification.mismatches.join("; ")}`,
        }
      : null;

    if (!verification.filesMatch) {
      // Se escribió, pero el contenido NO coincide: no es éxito.
      return {
        phase: "unrecoverable",
        verification,
        auditRecord: audit,
        error: "La verificación posterior detectó que el repo no coincide con la propuesta aprobada.",
      };
    }

    // Contenido OK. Si corrieron los checks del proyecto y fallaron, se marca
    // explícitamente: aplicación exitosa PERO con pruebas fallidas.
    if (verification.projectChecks?.ran && !verification.projectChecks.passed) {
      return { phase: "applied_with_test_failures", verification, auditRecord: audit };
    }

    return { phase: "applied", verification, auditRecord: audit };
  };
}

/** Arista tras generar: fallo -> END; ok -> approvalTask. */
function routeAfterGenerate(state: HuStateType): "approvalTask" | typeof END {
  return state.phase === "failed" ? END : "approvalTask";
}

/**
 * Arista tras la aprobacion humana:
 *  - revise con cupo -> regenerar HU.
 *  - approved -> technicalAnalysisTask (Fase 10).
 *  - rejected / revision_limit -> END (la HU rechazada NO llega al análisis).
 */
function routeAfterApproval(
  state: HuStateType,
): "generateHuTask" | "technicalAnalysisTask" | typeof END {
  const last = state.decisions[state.decisions.length - 1];
  if (last?.action === "revise" && state.phase === "none") {
    return "generateHuTask";
  }
  if (state.phase === "approved") {
    return "technicalAnalysisTask";
  }
  return END;
}

/** Arista tras el análisis técnico: fallo -> END; ok -> clasificar. */
function routeAfterTechnical(state: HuStateType): "classifyTask" | typeof END {
  return state.phase === "tech_failed" ? END : "classifyTask";
}

/**
 * Arista tras clasificar la viabilidad (Fase 11):
 *  - ready           -> developTask (Claude).
 *  - partially_ready -> partialDecisionTask (decisión humana).
 *  - blocked         -> END (no se ejecuta Claude; motivos disponibles).
 */
function routeAfterClassify(
  state: HuStateType,
): "developTask" | "partialDecisionTask" | typeof END {
  if (state.feasibility === "ready") return "developTask";
  if (state.feasibility === "partially_ready") return "partialDecisionTask";
  return END; // blocked (o estado inesperado): detener sin desarrollar
}

/**
 * Arista tras la decisión de partially_ready:
 *  - proceed (phase vuelve a tech_analyzed) -> developTask.
 *  - cualquier otra (blocked) -> END.
 */
function routeAfterPartial(state: HuStateType): "developTask" | typeof END {
  return state.phase === "tech_analyzed" ? "developTask" : END;
}

/** Arista tras develop (Fase 12): fallo -> END; propuesta válida -> revisión funcional. */
function routeAfterDevelop(state: HuStateType): "functionalReviewTask" | typeof END {
  return state.phase === "dev_proposed" ? "functionalReviewTask" : END;
}

/**
 * Arista tras la revisión FUNCIONAL (Fase 12):
 *  - review_failed (fallo del revisor)       -> END.
 *  - aprobado (hash coincide)                -> qualityReviewTask.
 *  - rechazado + quedan ciclos               -> developTask (corrige).
 *  - rechazado + sin ciclos                  -> END (reviews_exhausted, marcado aparte).
 */
function routeAfterFunctional(
  state: HuStateType,
): "qualityReviewTask" | "developTask" | "reviewsExhaustedTask" | typeof END {
  if (state.phase === "review_failed") return END;
  if (state.functionalApprovedHash === state.devProposalHash && state.devProposalHash !== "") {
    return "qualityReviewTask";
  }
  // rechazado
  if (state.reviewCycles < MAX_REVIEW_CYCLES) return "developTask";
  return "reviewsExhaustedTask"; // límite global agotado
}

/**
 * Arista tras la revisión de CALIDAD (Fase 12):
 *  - review_failed -> END.
 *  - aprobado (hash) -> bothReviewsGate (verifica que ambas = hash actual).
 *  - rechazado + quedan ciclos -> developTask (corrige; luego re-revisa AMBAS).
 *  - rechazado + sin ciclos -> END.
 */
function routeAfterQuality(
  state: HuStateType,
): "bothReviewsTask" | "developTask" | "reviewsExhaustedTask" | typeof END {
  if (state.phase === "review_failed") return END;
  if (state.qualityApprovedHash === state.devProposalHash && state.devProposalHash !== "") {
    return "bothReviewsTask";
  }
  if (state.reviewCycles < MAX_REVIEW_CYCLES) return "developTask";
  return "reviewsExhaustedTask";
}

/** Arista tras el gate de ambas revisiones: reviews_passed -> aprobación final. */
function routeAfterBoth(state: HuStateType): "finalApprovalTask" | typeof END {
  return state.phase === "reviews_passed" ? "finalApprovalTask" : END;
}

/**
 * Arista tras la APROBACIÓN FINAL (Fase 13):
 *  - ready_to_apply          -> applyTask (aplica).
 *  - request_changes         -> developTask (corrige; re-revisa ambas). La
 *    decisión request_changes deja phase=dev_proposed como marcador.
 *  - final_approval_rejected -> END (definitivo, no se aplica).
 */
function routeAfterFinal(state: HuStateType): "applyTask" | "developTask" | typeof END {
  if (state.phase === "ready_to_apply") return "applyTask";
  const last = state.decisions[state.decisions.length - 1];
  if (last?.action === "request_changes") return "developTask";
  return END; // final_approval_rejected
}

/**
 * Arista tras APLICAR (Fase 13):
 *  - applied (provisional) -> verifyTask (confirma contenido).
 *  - rolled_back / unrecoverable / apply_blocked -> END (con auditoría).
 */
function routeAfterApply(state: HuStateType): "verifyTask" | typeof END {
  return state.phase === "applied" ? "verifyTask" : END;
}

export interface BuildHuGraphOptions {
  router?: AgentRouter;
  checkpointer?: BaseCheckpointSaver;
  /** Directorio del proyecto a analizar (solo lectura). Por defecto cwd. */
  rootDir?: string;
  /**
   * (Fase 13) Directorio DONDE SE APLICAN los cambios. Por defecto == rootDir.
   * Permite aplicar en una copia temporal (prueba manual) sin tocar el repo que
   * se analiza. El aplicador solo escribe dentro de este directorio.
   */
  applyDir?: string;
  /**
   * (Fase 13) Hook opt-in para correr tests/typecheck tras aplicar. Si se omite,
   * el grafo NO ejecuta checks (determinista). Inyectarlo permite distinguir
   * "applied" de "applied_with_test_failures".
   */
  runChecks?: RunProjectChecks;
  /**
   * (Project Registry) Exigir proyecto vinculado (`state.project`) para leer,
   * desarrollar y aplicar. El Core lo activa; `rootDir`/`applyDir` quedan solo
   * para el uso directo del grafo sin proyecto.
   */
  requireProject?: boolean;
  /** (Project Registry) Guardia previa a la escritura (obligatoria para aplicar con proyecto). */
  applyGuard?: ApplyGuard;
}

/**
 * Router por defecto del flujo de HU. Igual que el default, pero `develop` usa
 * `rawPrompt: true` (el flujo de HU arma su propio prompt JSON, distinto del
 * formato "FILE:" del pipeline viejo).
 */
function defaultHuRouter(): AgentRouter {
  const mock = new MockAgentAdapter();
  return new MapAgentRouter({
    analyze: mock,
    develop: new ClaudeCliAdapter({ rawPrompt: true }),
    review: mock,
    huAnalyst: new KiroCliAdapter(),
    technicalAnalyst: new KiroCliAdapter({ trustTools: "fs_read" }),
    functionalReviewer: new KiroCliAdapter({ trustTools: "fs_read" }),
    qualityReviewer: new KiroCliAdapter({ trustTools: "fs_read" }),
  });
}

export function buildHuGraph(options: BuildHuGraphOptions = {}) {
  const router = options.router ?? defaultHuRouter();
  const checkpointer = options.checkpointer ?? createSqliteCheckpointer();
  const rootDir = options.rootDir ?? process.cwd();
  // El directorio de aplicación por defecto es el mismo que se analiza, pero se
  // puede separar para aplicar en una copia temporal (Fase 13).
  const applyDir = options.applyDir ?? rootDir;
  const policy: RootPolicy = { fallbackRoot: rootDir, requireProject: options.requireProject ?? false };
  const applyPolicy = { ...policy, fallbackApplyDir: applyDir, guard: options.applyGuard };

  const workflow = new StateGraph(HuState)
    .addNode("generateHuTask", makeGenerateHu(router, policy))
    .addNode("approvalTask", approvalGate)
    .addNode("technicalAnalysisTask", makeTechnicalAnalysis(router, policy))
    .addNode("classifyTask", classifyTask)
    .addNode("partialDecisionTask", partialDecisionGate)
    .addNode("developTask", makeDevelop(router, policy))
    .addNode("functionalReviewTask", makeFunctionalReview(router, policy))
    .addNode("qualityReviewTask", makeQualityReview(router, policy))
    .addNode("bothReviewsTask", gateBothReviews)
    .addNode("reviewsExhaustedTask", reviewsExhausted)
    .addNode("finalApprovalTask", finalApprovalGate)
    .addNode("applyTask", makeApply(applyPolicy))
    .addNode("verifyTask", makeVerify(applyPolicy, options.runChecks))
    .addEdge(START, "generateHuTask")
    .addConditionalEdges("generateHuTask", routeAfterGenerate, {
      approvalTask: "approvalTask",
      [END]: END,
    })
    .addConditionalEdges("approvalTask", routeAfterApproval, {
      generateHuTask: "generateHuTask",
      technicalAnalysisTask: "technicalAnalysisTask",
      [END]: END,
    })
    .addConditionalEdges("technicalAnalysisTask", routeAfterTechnical, {
      classifyTask: "classifyTask",
      [END]: END,
    })
    .addConditionalEdges("classifyTask", routeAfterClassify, {
      developTask: "developTask",
      partialDecisionTask: "partialDecisionTask",
      [END]: END,
    })
    .addConditionalEdges("partialDecisionTask", routeAfterPartial, {
      developTask: "developTask",
      [END]: END,
    })
    // (Fase 12) develop -> revisión funcional.
    .addConditionalEdges("developTask", routeAfterDevelop, {
      functionalReviewTask: "functionalReviewTask",
      [END]: END,
    })
    .addConditionalEdges("functionalReviewTask", routeAfterFunctional, {
      qualityReviewTask: "qualityReviewTask",
      developTask: "developTask", // rechazo -> corrige
      reviewsExhaustedTask: "reviewsExhaustedTask",
      [END]: END,
    })
    .addConditionalEdges("qualityReviewTask", routeAfterQuality, {
      bothReviewsTask: "bothReviewsTask",
      developTask: "developTask", // rechazo de calidad -> corrige -> re-revisa AMBAS
      reviewsExhaustedTask: "reviewsExhaustedTask",
      [END]: END,
    })
    .addConditionalEdges("bothReviewsTask", routeAfterBoth, {
      finalApprovalTask: "finalApprovalTask",
      [END]: END,
    })
    .addEdge("reviewsExhaustedTask", END)
    // (Fase 13) Aprobación humana final -> aplica / corrige / rechaza.
    .addConditionalEdges("finalApprovalTask", routeAfterFinal, {
      applyTask: "applyTask",
      developTask: "developTask", // request_changes -> corrige y re-revisa
      [END]: END, // final_approval_rejected
    })
    // (Fase 13) Aplicación -> verificación (si escribió) o fin (rollback/error).
    .addConditionalEdges("applyTask", routeAfterApply, {
      verifyTask: "verifyTask",
      [END]: END,
    })
    // (Fase 13) Verificación posterior es terminal.
    .addEdge("verifyTask", END);

  return workflow.compile({ checkpointer });
}

export { Command };
