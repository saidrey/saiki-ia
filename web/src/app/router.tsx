import { createBrowserRouter } from "react-router";
import { AppShell } from "../components/AppShell";
import { RouteError } from "../routes/RouteError";

/**
 * Rutas de Jev. Cada página se carga con `lazy` (división de bundle por ruta).
 * Se añaden por pasos según docs/FRONTEND_PROPOSAL.md §3: solo existen las
 * rutas cuya página ya está implementada.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteError,
    children: [
      {
        index: true,
        lazy: () => import("../routes/HomePage").then((m) => ({ Component: m.HomePage })),
      },
      {
        path: "sessions/:sessionId",
        lazy: () => import("../routes/SessionPage").then((m) => ({ Component: m.SessionPage })),
      },
      {
        path: "executions/:executionId",
        lazy: () => import("../routes/ExecutionPage").then((m) => ({ Component: m.ExecutionPage })),
      },
      {
        path: "projects",
        lazy: () => import("../routes/ProjectsPage").then((m) => ({ Component: m.ProjectsPage })),
      },
      {
        path: "knowledge",
        lazy: () => import("../routes/KnowledgePage").then((m) => ({ Component: m.KnowledgePage })),
      },
      {
        path: "knowledge/:docId",
        lazy: () => import("../routes/KnowledgeDocPage").then((m) => ({ Component: m.KnowledgeDocPage })),
      },
      {
        path: "*",
        lazy: () => import("../routes/NotFoundPage").then((m) => ({ Component: m.NotFoundPage })),
      },
    ],
  },
]);
