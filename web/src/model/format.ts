const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "hace 2 minutos", "ayer"… a partir de una fecha ISO de la API. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "hace un momento";
  if (abs < 3600) return relative.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(s / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(s / 86_400), "day");
  return dateTime.format(t);
}

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : dateTime.format(t);
}

export function clockTime(ms: number): string {
  return clock.format(ms);
}

/** Tiempo transcurrido como "m:ss" (o "h:mm:ss"). */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Duración legible: "45 s", "3 min 05 s", "1 h 02 min". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} min ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
