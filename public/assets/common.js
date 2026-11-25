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

// 45 -> "45 min", 90 -> "1 h 30 min", 120 -> "2 h"
function fmtDuration(min) {
  if (!min) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
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

// "2" -> "2nd edition", "Revised" -> "Revised edition", "Deluxe Edition" stays as is.
function editionLabel(ed) {
  const e = String(ed ?? "").trim();
  if (!e) return "";
  if (/^\d+$/.test(e)) {
    const n = Number(e);
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
    return `${n}${suffix} edition`;
  }
  return /edition/i.test(e) ? e : `${e} edition`;
}

// "Wingspan: European Expansion" shown under Wingspan reads better as "European Expansion".
function shortExpName(name, baseName) {
  const n = String(name || "");
  const b = String(baseName || "").trim();
  if (b && n.toLowerCase().startsWith(b.toLowerCase())) {
    const rest = n.slice(b.length).replace(/^\s*[:–—-]\s*/, "").trim();
    if (rest) return rest;
  }
  return n;
}

// ---------- Signing in ----------
// Sign-in happens at the gateway, which serves /oauth2/ on this same name. Google sends the
// browser back to rd, which has to be a full address, so it is built from this page's origin.
function signInUrl(path = location.pathname + location.search) {
  return `/oauth2/start?rd=${encodeURIComponent(location.origin + path)}`;
}

function signOutUrl(path = "/games") {
  return `/oauth2/sign_out?rd=${encodeURIComponent(location.origin + path)}`;
}

// <a href="/oauth2/start" data-rd="/admin"> gets the full link (used by pages the server writes).
function wireAuthLinks(root = document) {
  root.querySelectorAll('a[href^="/oauth2/"][data-rd]').forEach((a) => {
    a.href = a.getAttribute("href").startsWith("/oauth2/sign_out") ? signOutUrl(a.dataset.rd) : signInUrl(a.dataset.rd);
  });
}

// { email } for someone who may see the stats (email is null at home without signing in),
// or null when they may not.
async function whoAmI() {
  try {
    return await api("api/me");
  } catch {
    return null;
  }
}
