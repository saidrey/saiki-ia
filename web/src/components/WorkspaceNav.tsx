import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useHealth } from "../hooks/useHealth";
import { ApiStatus } from "./ApiStatus";
import { SessionRail } from "./SessionRail";
import logo from "../assets/logo-saiki-ia-nav.png";
import styles from "./WorkspaceNav.module.css";

const STORAGE_KEY = "saiki.workspace.navCollapsed";
const NARROW = "(max-width: 860px)";

/** Preferencia del visitante; sin ella, plegada solo en pantallas estrechas. */
function initialCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    // Almacenamiento no disponible: se usa el valor por defecto.
  }
  return window.matchMedia(NARROW).matches;
}

const icon = {
  sessions: "M4 6h12M4 10h12M4 14h8",
  projects: "M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 2h6A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z",
  knowledge: "M5 4.5h7.5A2.5 2.5 0 0 1 15 7v9H7.5A2.5 2.5 0 0 1 5 13.5zM5 13.5A2.5 2.5 0 0 1 7.5 11H15",
};

function Icon({ d }: { d: string }) {
  return (
    <svg className={styles.icon} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.link} ${styles.active}` : styles.link);

/**
 * Navegación lateral de la app: plegable a iconos para dar espacio al
 * contenido. En pantallas estrechas es una barra superior que se despliega.
 */
export function WorkspaceNav() {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const { connection } = useHealth();
  const { pathname } = useLocation();
  // Sesiones agrupa el inicio, las sesiones y sus ejecuciones.
  const inSessions = pathname === "/" || pathname.startsWith("/sessions/") || pathname.startsWith("/executions/");
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORAGE_KEY, c ? "0" : "1");
      } catch {
        // Sin almacenamiento: la preferencia dura lo que la página.
      }
      return !c;
    });

  return (
    <div className={styles.nav} data-collapsed={collapsed ? "" : undefined}>
      <div className={styles.top}>
        <Link to="/" className={styles.brand} aria-label="Saiki-IA, inicio">
          {/* Decorativo: el enlace ya se llama «Saiki-IA, inicio». */}
          <img src={logo} alt="" width={240} height={178} className={styles.brandLogo} />
          <span className={styles.brandText}>
            Saiki-<span className={styles.brandAccent}>IA</span>
          </span>
        </Link>
        <button type="button" className={styles.toggle} aria-expanded={!collapsed} aria-controls="workspace-nav-panel" onClick={toggle}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
            <rect x="3" y="4" width="14" height="12" rx="2" />
            <path d="M8 4v12" />
          </svg>
          <span className="visually-hidden">{collapsed ? "Expandir navegación" : "Contraer navegación"}</span>
        </button>
      </div>

      <div id="workspace-nav-panel" className={styles.panel}>
        <nav aria-label="Principal" className={styles.links}>
          <Link to="/" className={linkClass({ isActive: inSessions })} aria-current={inSessions ? "page" : undefined} title={collapsed ? "Sesiones" : undefined}>
            <Icon d={icon.sessions} />
            <span className={styles.linkText}>Sesiones</span>
          </Link>
          <NavLink to="/projects" className={linkClass} title={collapsed ? "Proyectos" : undefined}>
            <Icon d={icon.projects} />
            <span className={styles.linkText}>Proyectos</span>
          </NavLink>
          <NavLink to="/knowledge" className={linkClass} title={collapsed ? "Conocimiento" : undefined}>
            <Icon d={icon.knowledge} />
            <span className={styles.linkText}>Conocimiento</span>
          </NavLink>
        </nav>
        <div className={styles.recent}>
          <SessionRail />
        </div>
        <div className={styles.status}>
          <ApiStatus connection={connection} />
        </div>
      </div>
    </div>
  );
}
