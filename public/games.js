// Read-only collection browser for guests and family.
const filters = { q: "", players: "", time: "", type: "", sort: "name" };
let games = [];

const ICONS = {
  players: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 13.7c2.3.2 4 1.8 4.5 4.6"/></svg>`,
  time: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

function playersText(g) {
  if (!g.min_players) return null;
  return g.max_players && g.max_players !== g.min_players ? `${g.min_players}–${g.max_players}` : `${g.min_players}`;
}

function timeText(min) {
  if (!min) return null;
  if (min < 90) return `${min} min`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function weightText(w) {
  if (!w) return null;
  if (w < 2) return "Light";
  if (w < 3) return "Medium";
  if (w < 4) return "Heavy";
  return "Very heavy";
}

function coverStyle(g) {
  return g.image || g.thumbnail
    ? `style="background-image:url('covers/${g.id}'), radial-gradient(circle at 30% 20%, #2d5247, #10201b)"`
    : "";
}

// ---------- Filtering ----------
function matches(g) {
  if (filters.q) {
    const hay = [g.name, g.designers, g.categories, g.mechanics, g.types, g.edition, ...g.expansions.map((x) => x.name)]
      .join(" ").toLowerCase();
    if (!filters.q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  if (filters.players) {
    const n = Number(filters.players);
    if (!g.min_players) return false;
    const max = g.max_players || g.min_players;
    if (n >= 6 ? max < 6 : n < g.min_players || n > max) return false;
  }
  if (filters.type && !splitList(g.types).includes(filters.type)) return false;
  if (filters.time) {
    if (!g.playing_time) return false;
    if (filters.time === "long" ? g.playing_time <= 120 : g.playing_time > Number(filters.time)) return false;
  }
  return true;
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  plays: (a, b) => b.plays - a.plays || a.name.localeCompare(b.name),
  recent: (a, b) => (b.last_played || "").localeCompare(a.last_played || "") || a.name.localeCompare(b.name),
  added: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name),
  time: (a, b) => (a.playing_time || 9999) - (b.playing_time || 9999) || a.name.localeCompare(b.name),
  weight: (a, b) => (a.weight || 99) - (b.weight || 99) || a.name.localeCompare(b.name),
};

// ---------- Grid ----------
function card(g) {
  const facts = [
    playersText(g) && `<span>${ICONS.players}${playersText(g)}</span>`,
    g.playing_time && `<span>${ICONS.time}${timeText(g.playing_time)}</span>`,
    g.weight ? `<span class="muted" title="Complexity ${g.weight.toFixed(1)} of 5">${weightText(g.weight)}</span>`
      : g.min_age && `<span class="muted">Age ${g.min_age}+</span>`,
  ].filter(Boolean).join("");
  return `
    <a class="shelf-card" href="#game-${g.id}" aria-label="${esc(g.name)}">
      <div class="game-cover ${g.image || g.thumbnail ? "" : "placeholder"}" ${coverStyle(g)}>
        ${g.image || g.thumbnail ? "" : initial(g.name)}
        ${g.plays ? `<span class="play-badge" title="Times we've played it">${g.plays}×</span>` : ""}
      </div>
      <div class="game-info">
        <h3>${esc(g.name)}</h3>
        <div class="sub">${[g.year, g.edition && esc(editionLabel(g.edition))].filter(Boolean).join(" · ")}</div>
        ${facts ? `<div class="facts">${facts}</div>` : ""}
        ${g.expansions.length ? `<div class="exp-count">+ ${g.expansions.length} expansion${g.expansions.length === 1 ? "" : "s"}</div>` : ""}
      </div>
    </a>`;
}

function renderGrid() {
  const list = games.filter(matches).sort(SORTS[filters.sort]);
  const active = filters.q || filters.players || filters.time || filters.type;
  $("#count").innerHTML = active
    ? `${list.length} of ${games.length} games match · <button class="link-btn" id="clear">Clear filters</button>`
    : "";
  $("#grid").innerHTML = list.length
    ? list.map(card).join("")
    : `<div class="empty panel">${games.length ? "No games match that. Try fewer filters." : "The collection is empty so far."}</div>`;
}

function $(sel) {
  return document.querySelector(sel);
}

// ---------- Detail dialog ----------
function splitList(text) {
  return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function chips(text) {
  return splitList(text).map((s) => `<span class="tag">${esc(s)}</span>`).join("");
}

function detail(g) {
  const facts = [
    ["Players", playersText(g)],
    ["Time", timeText(g.playing_time)],
    ["Age", g.min_age ? `${g.min_age}+` : null],
    ["Complexity", weightText(g.weight) && `${weightText(g.weight)} <small>${g.weight.toFixed(1)}/5</small>`],
    ["BGG rating", g.rating ? `${g.rating.toFixed(1)} <small>/10</small>` : null],
  ].filter(([, v]) => v);

  const record = g.plays
    ? `
      <section>
        <h3>Our record</h3>
        <p class="muted">Played ${g.plays} time${g.plays === 1 ? "" : "s"}${g.last_played ? `, most recently ${relDate(g.last_played).toLowerCase()}` : ""}.
        ${g.timed_plays ? `It usually takes us about <b>${fmtDuration(g.avg_duration)}</b>${g.playing_time ? ` (the box says ${timeText(g.playing_time)})` : ""}${g.timed_plays > 1 && g.fastest !== g.longest ? `, from ${fmtDuration(g.fastest)} to ${fmtDuration(g.longest)}` : ""}.` : ""}
        ${g.champion ? `Reigning champion: <b class="champ-name"><span class="dot" style="background:${esc(g.champion.color)}"></span>${esc(g.champion.name)}</b> ♛` : ""}</p>
        <div class="record-list">${g.results.map((r) => `
          <div class="record">
            <span class="pname"><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</span>
            <span class="wl-bar"><i style="width:${Math.round((r.wins / r.plays) * 100)}%"></i></span>
            <span class="nums"><b class="w">${r.wins}</b> – <span class="l">${r.losses}</span>${r.best_score != null ? ` <small class="muted">· best ${r.best_score}</small>` : ""}</span>
          </div>`).join("")}</div>
      </section>`
    : `<section><h3>Our record</h3><p class="muted">We haven't logged a play of this one yet. Want to try it?</p></section>`;

  const expansions = g.expansions.length
    ? `
      <section>
        <h3>Expansions we have</h3>
        <ul class="exp-list">${g.expansions.map((x) => `
          <li>${esc(shortExpName(x.name, g.name))}
            ${x.year ? `<span class="muted">${x.year}</span>` : ""}
            ${x.edition ? `<span class="edition-tag">${esc(editionLabel(x.edition))}</span>` : ""}
            ${x.plays ? `<span class="muted">· used ${x.plays}×</span>` : ""}</li>`).join("")}</ul>
      </section>`
    : "";

  const about = g.description
    ? `<section><h3>About the game</h3><p class="description clamp" id="desc">${esc(g.description)}</p>
         <button class="link-btn" id="more" hidden>Read more</button></section>`
    : "";

  const tags = [
    g.types && `<div><span class="filter-label">Type</span>${chips(g.types)}</div>`,
    g.categories && `<div><span class="filter-label">Category</span>${chips(g.categories)}</div>`,
    g.mechanics && `<div><span class="filter-label">Mechanism</span>${chips(g.mechanics)}</div>`,
    g.designers && `<div><span class="filter-label">Designer</span>${chips(g.designers)}</div>`,
  ].filter(Boolean).join("");

  return `
    <button class="modal-close" id="close" aria-label="Close">${ICONS.close}</button>
    <div class="modal-hero">
      <div class="modal-cover ${g.image || g.thumbnail ? "" : "placeholder"}" ${coverStyle(g)}>${g.image || g.thumbnail ? "" : initial(g.name)}</div>
      <div class="modal-title">
        <h2 id="modal-title">${esc(g.name)}</h2>
        <div class="sub">${[g.year, g.edition && `<span class="edition-tag">${esc(editionLabel(g.edition))}</span>`].filter(Boolean).join(" ")}</div>
        ${facts.length ? `<dl class="fact-grid">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : ""}
        ${g.bgg_id ? `<a class="bgg-link" href="https://boardgamegeek.com/boardgame/${g.bgg_id}" target="_blank" rel="noopener">See it on BoardGameGeek ↗</a>` : ""}
      </div>
    </div>
    <div class="modal-sections">
      ${record}
      ${expansions}
      ${about}
      ${tags ? `<section class="tag-groups">${tags}</section>` : ""}
    </div>`;
}

async function openGame(id) {
  const modal = $("#modal");
  $("#modal-body").innerHTML = `<div class="empty">Loading…</div>`;
  if (!modal.open) modal.showModal();
  try {
    const g = await api(`api/collection/${id}`);
    $("#modal-body").innerHTML = detail(g);
    document.title = `${g.name} · Our Games`;
    const desc = $("#desc");
    if (desc && desc.scrollHeight > desc.clientHeight + 4) {
      $("#more").hidden = false;
      $("#more").onclick = () => { desc.classList.remove("clamp"); $("#more").remove(); };
    }
    $("#close").focus();
  } catch (err) {
    $("#modal-body").innerHTML = `<button class="modal-close" id="close" aria-label="Close">${ICONS.close}</button><div class="empty">${esc(err.message)}</div>`;
  }
}

// True when the dialog was opened by tapping a card (so "back" returns to the grid).
// False when someone arrived through a shared #game- link: then just drop the hash.
let openedFromGrid = false;

function closeGame() {
  if (openedFromGrid && location.hash.startsWith("#game-")) {
    history.back();
  } else {
    history.replaceState(null, "", location.pathname + location.search);
    $("#modal").close();
    document.title = "Our Games";
  }
  openedFromGrid = false;
}

// The URL hash (#game-12) drives the dialog, so the back button closes it and links can be shared.
function syncFromHash() {
  const m = location.hash.match(/^#game-(\d+)$/);
  if (m) openGame(m[1]);
  else if ($("#modal").open) $("#modal").close();
  if (!m) document.title = "Our Games";
}

// ---------- Wiring ----------
function setupSeg(id, key) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    filters[key] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderGrid();
  });
}
setupSeg("#f-players", "players");
setupSeg("#f-time", "time");
$("#grid").addEventListener("click", (e) => {
  if (e.target.closest(".shelf-card")) openedFromGrid = true;
});
$("#q").addEventListener("input", (e) => { filters.q = e.target.value.trim().toLowerCase(); renderGrid(); });
$("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; renderGrid(); });
$("#f-type").addEventListener("change", (e) => { filters.type = e.target.value; renderGrid(); });
$("#count").addEventListener("click", (e) => {
  if (e.target.id !== "clear") return;
  Object.assign(filters, { q: "", players: "", time: "", type: "" });
  $("#q").value = "";
  $("#f-type").value = "";
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === ""));
  renderGrid();
});

const modal = $("#modal");
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.closest("#close")) closeGame();
});
modal.addEventListener("cancel", (e) => { e.preventDefault(); closeGame(); });
window.addEventListener("hashchange", syncFromHash);

(async function init() {
  try {
    games = await api("api/collection");
    const exps = games.reduce((n, g) => n + g.expansions.length, 0);
    $("#subtitle").textContent = `${games.length} game${games.length === 1 ? "" : "s"}${exps ? ` and ${exps} expansion${exps === 1 ? "" : "s"}` : ""} on the shelf · tap one to learn more`;
    // Type filter lists only the types that are in the collection.
    const types = [...new Set(games.flatMap((g) => splitList(g.types)))].sort();
    if (types.length) {
      $("#f-type").insertAdjacentHTML("beforeend", types.map((t) => `<option>${esc(t)}</option>`).join(""));
      $("#type-filter").hidden = false;
    }
    renderGrid();
    syncFromHash();
  } catch (err) {
    $("#subtitle").textContent = `Could not load the collection: ${err.message}`;
  }
})();
