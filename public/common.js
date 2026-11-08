// Small helpers shared by the dashboard and admin pages.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtDate(iso, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, opts);
}

function relDate(iso) {
  if (!iso) return "";
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const d = new Date(iso + "T12:00:00");
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return fmtDate(iso, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function initial(name) {
  return esc((name || "?").trim().charAt(0).toUpperCase());
}

// Small square cover. Images are served from the local cache at covers/<gameId>;
// if one can't be loaded, the game's initial is shown instead.
function thumb(gameId, hasImage, name) {
  const ph = `<div class="thumb-ph">${initial(name)}</div>`;
  return hasImage
    ? `<img src="covers/${Number(gameId)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.ph" data-ph="${esc(ph)}">`
    : ph;
}
