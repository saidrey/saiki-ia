import { describe, expect, it } from "vitest";
import type { ExecutionProject, Project } from "../api/types";
import { applyDestination, executionProjectNotices, fieldOfError, historyText, isSelectable, sessionProjectLabel, unavailableReason } from "./projects";

const project: Project = {
  id: "prj-1", name: "app", rootPath: "/repos/app", status: "active", applyMode: "sandbox",
  createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", deactivatedAt: null, health: "ok",
};
const bound: ExecutionProject = {
  id: "prj-1", name: "app", rootPath: "/repos/app", applyMode: "sandbox", boundAt: "2026-10-30T00:00:00.000Z",
  current: { name: "app", status: "active", applyMode: "sandbox", health: "ok" },
};

describe("proyectos elegibles", () => {
  it("solo los activos y sanos; el motivo se nombra", () => {
    expect(isSelectable(project)).toBe(true);
    expect(isSelectable({ ...project, status: "inactive" })).toBe(false);
    expect(unavailableReason({ ...project, status: "inactive" })).toBe("desactivado");
    expect(unavailableReason({ ...project, health: "missing" })).toBe("no existe");
    expect(unavailableReason(project)).toBeNull();
  });

  it("errores de la API junto al campo que corresponde", () => {
    expect(fieldOfError("name_taken")).toBe("name");
    expect(fieldOfError("not_a_repository")).toBe("path");
    expect(fieldOfError("already_registered")).toBe("path");
    expect(fieldOfError("confirmation_required")).toBe("applyMode");
    expect(fieldOfError("internal_error")).toBeNull();
  });

  it("etiqueta del proyecto de una sesión", () => {
    const byId = new Map([[project.id, project]]);
    expect(sessionProjectLabel({ projectId: "prj-1" }, byId)).toBe("app");
    expect(sessionProjectLabel({}, byId)).toBe("Sin proyecto");
  });
});

describe("destino de la aplicación", () => {
  it("real solo si la copia de la ejecución y el proyecto actual están en real", () => {
    expect(applyDestination({ project: bound })?.mode).toBe("sandbox");
    expect(applyDestination({ project: { ...bound, applyMode: "real" } })?.mode).toBe("sandbox");
    const real = { ...bound, applyMode: "real" as const, current: { ...bound.current!, applyMode: "real" as const } };
    expect(applyDestination({ project: real })).toEqual({ mode: "real", text: "Se aplicará directamente en el repositorio /repos/app." });
    expect(applyDestination({ project: null })).toBeNull();
  });
});

describe("avisos del proyecto de una ejecución", () => {
  it("sin avisos si todo está bien; anterior al registro solo se puede rechazar", () => {
    expect(executionProjectNotices({ project: bound })).toEqual([]);
    expect(executionProjectNotices({ project: undefined })).toEqual([]);
    const [legacy] = executionProjectNotices({ project: null });
    expect(legacy.tone).toBe("blocked");
    expect(legacy.text).toMatch(/Solo puede rechazarse/);
  });

  it("desactivado, repositorio no disponible o renombrado", () => {
    const n = executionProjectNotices({
      project: { ...bound, current: { name: "app-2", status: "inactive", applyMode: "sandbox", health: "moved", healthDetail: "otro repo" } },
    });
    expect(n.map((x) => x.tone)).toEqual(["blocked", "blocked", "info"]);
    expect(n[0].text).toMatch(/desactivado/);
    expect(n[1].text).toMatch(/movido o sustituido \(otro repo\)/);
    expect(n[2].text).toMatch(/app-2/);
  });
});

describe("historial", () => {
  it("cada cambio en una frase", () => {
    const e = { id: "h", projectId: "prj-1", actor: "said", at: "2026-10-30T00:00:00.000Z" };
    expect(historyText({ ...e, action: "renamed", details: { from: "a", to: "b" } })).toBe('Renombrado de "a" a "b"');
    expect(historyText({ ...e, action: "apply_mode_changed", details: { from: "sandbox", to: "real" } })).toBe(
      "Modo de aplicación: Sandbox → Repositorio real",
    );
    expect(historyText({ ...e, action: "deactivated", details: {} })).toBe("Desactivado");
  });
});
