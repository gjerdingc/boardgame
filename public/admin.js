const PALETTE = ["#f4b860", "#7bd389", "#6cb4ee", "#e76f51", "#c792ea", "#4dd0c8", "#ff8fab", "#f9e07f"];
const state = { players: [], games: [], plays: [], editingId: null };
const $ = (sel) => document.querySelector(sel);

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${isError ? "error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), 3000);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ---------- Tabs ----------
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
    history.replaceState(null, "", `#${b.dataset.tab}`);
  })
);
const initialTab = location.hash.slice(1);
if (initialTab) document.querySelector(`.tabs button[data-tab="${initialTab}"]`)?.click();

// ---------- Loading ----------
async function loadAll() {
  [state.players, state.games, state.plays] = await Promise.all([
    api("api/players"),
    api("api/games"),
    api("api/plays?limit=100"),
  ]);
  renderPlayForm();
  renderPlays();
  renderGames();
  renderPlayers();
}

// ---------- Plays ----------

// Current player selections in the form: Map(playerId -> { winner, score }).
function readPicks() {
  return new Map(
    [...document.querySelectorAll("#play-players .pick.on")].map((el) => [
      el.dataset.id,
      { winner: el.querySelector(".win-toggle").classList.contains("on"), score: el.querySelector("input[type=number]").value },
    ])
  );
}

function renderPlayForm(picks = readPicks()) {
  const sel = $("#play-game");
  const prev = sel.value;
  sel.innerHTML = state.games.length
    ? `<option value="">Choose a game…</option>` + state.games.map((g) => `<option value="${g.id}">${esc(g.name)}${g.year ? ` (${g.year})` : ""}</option>`).join("")
    : `<option value="">Add a game first (Games tab)</option>`;
  if (prev) sel.value = prev;
  if (!$("#play-date").value) $("#play-date").value = today();

  $("#play-players").innerHTML = state.players.length
    ? state.players
        .map((p) => {
          const pick = picks.get(String(p.id));
          return `
        <div class="pick ${pick ? "on" : ""}" data-id="${p.id}">
          <input type="checkbox" ${pick ? "checked" : ""} aria-label="${esc(p.name)} played">
          <span class="pname"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>
          <input type="number" step="any" placeholder="Score" aria-label="Score" value="${esc(pick?.score ?? "")}">
          <button type="button" class="win-toggle ${pick?.winner ? "on" : ""}">♛ Winner</button>
        </div>`;
        })
        .join("")
    : `<div class="muted">Add players first (Players tab).</div>`;
}

function setEditing(play) {
  state.editingId = play ? play.id : null;
  $("#play-form-title").textContent = play ? `Edit play · ${play.game_name}, ${fmtDate(play.played_at)}` : "Log a play";
  $("#play-submit").textContent = play ? "Update play" : "Save play";
  $("#play-cancel").hidden = !play;
  $("#play-form").classList.toggle("editing", !!play);
  document.querySelectorAll("#plays-list .item").forEach((el) => el.classList.toggle("editing", el.dataset.playId === String(state.editingId)));
}

function startEdit(play) {
  const form = $("#play-form");
  form.game_id.value = String(play.game_id);
  form.played_at.value = play.played_at;
  form.notes.value = play.notes || "";
  renderPlayForm(new Map(play.players.map((p) => [String(p.player_id), { winner: p.winner, score: p.score ?? "" }])));
  setEditing(play);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetPlayForm({ keepPlayers }) {
  const form = $("#play-form");
  form.notes.value = "";
  if (state.editingId) {
    form.game_id.value = "";
    form.played_at.value = today();
  }
  const picks = keepPlayers ? new Map([...readPicks().keys()].map((id) => [id, { winner: false, score: "" }])) : new Map();
  setEditing(null);
  renderPlayForm(picks);
}

$("#play-cancel").addEventListener("click", () => resetPlayForm({ keepPlayers: false }));

$("#play-players").addEventListener("click", (e) => {
  const pick = e.target.closest(".pick");
  if (!pick) return;
  if (e.target.classList.contains("win-toggle")) {
    e.target.classList.toggle("on");
    return;
  }
  if (e.target.matches("input[type=number]")) return;
  const cb = pick.querySelector("input[type=checkbox]");
  if (e.target !== cb) cb.checked = !cb.checked;
  pick.classList.toggle("on", cb.checked);
  if (!cb.checked) pick.querySelector(".win-toggle").classList.remove("on");
});

$("#play-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const players = [...readPicks()].map(([id, p]) => ({ player_id: Number(id), winner: p.winner, score: p.score }));
  if (players.length && !players.some((p) => p.winner) && !confirm("No winner marked. Save anyway (everyone lost)?")) return;
  const body = { game_id: Number(form.game_id.value), played_at: form.played_at.value, notes: form.notes.value, players };
  const editing = state.editingId;
  try {
    if (editing) await api(`api/plays/${editing}`, { method: "PUT", body });
    else await api("api/plays", { method: "POST", body });
    toast(editing ? "Play updated ✓" : "Play saved 🎲");
    // After logging a new play, keep the same players ticked for the next round.
    resetPlayForm({ keepPlayers: !editing });
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
});

function renderPlays() {
  $("#plays-list").innerHTML = state.plays.length
    ? state.plays
        .map((p) => `
      <div class="item ${p.id === state.editingId ? "editing" : ""}" data-play-id="${p.id}">
        ${thumb(p.game_id, p.thumbnail, p.game_name)}
        <div class="grow">
          <b>${esc(p.game_name)} <span class="muted" style="font-weight:400">· ${fmtDate(p.played_at)}</span></b>
          <div class="chips">${p.players.map((pl) => `<span class="chip ${pl.winner ? "win" : ""}"><span class="dot" style="background:${esc(pl.color)}"></span>${pl.winner ? "♛ " : ""}${esc(pl.name)}${pl.score != null ? ` · ${pl.score}` : ""}</span>`).join("")}</div>
          ${p.notes ? `<div class="muted" style="font-size:.85rem;margin-top:4px">${esc(p.notes)}</div>` : ""}
        </div>
        <button class="btn ghost small" data-edit-play="${p.id}">Edit</button>
        <button class="btn danger small" data-del-play="${p.id}">Delete</button>
      </div>`)
        .join("")
    : `<div class="muted">No plays yet.</div>`;
}

$("#plays-list").addEventListener("click", async (e) => {
  const { editPlay, delPlay } = e.target.dataset;
  if (editPlay) {
    const play = state.plays.find((p) => String(p.id) === editPlay);
    if (play) startEdit(play);
    return;
  }
  if (!delPlay || !confirm("Delete this play?")) return;
  await api(`api/plays/${delPlay}`, { method: "DELETE" });
  if (String(state.editingId) === delPlay) resetPlayForm({ keepPlayers: false });
  toast("Play deleted");
  loadAll();
});

// ---------- Games ----------
function renderGames() {
  $("#games-list").innerHTML = state.games.length
    ? state.games
        .map((g) => `
      <div class="item">
        ${thumb(g.id, g.thumbnail || g.image, g.name)}
        <div class="grow">
          <b>${esc(g.name)}${g.year ? ` <span class="muted" style="font-weight:400">(${g.year})</span>` : ""}</b>
          <div class="muted" style="font-size:.85rem">
            ${[
              g.min_players ? `${g.min_players}${g.max_players && g.max_players !== g.min_players ? `–${g.max_players}` : ""} players` : null,
              g.playing_time ? `${g.playing_time} min` : null,
              g.rating ? `BGG ${g.rating.toFixed(1)}` : null,
              `${g.plays} play${g.plays === 1 ? "" : "s"}`,
            ].filter(Boolean).join(" · ")}
          </div>
        </div>
        ${g.bgg_id ? `<a class="btn ghost small" href="https://boardgamegeek.com/boardgame/${g.bgg_id}" target="_blank" rel="noopener">BGG</a>
        <button class="btn ghost small" data-refresh-game="${g.id}">Refresh</button>` : ""}
        <button class="btn danger small" data-del-game="${g.id}">Delete</button>
      </div>`)
        .join("")
    : `<div class="muted">No games yet. Search BoardGameGeek above.</div>`;
}

$("#games-list").addEventListener("click", async (e) => {
  const { delGame, refreshGame } = e.target.dataset;
  try {
    if (delGame) {
      const g = state.games.find((x) => String(x.id) === delGame);
      if (!confirm(`Delete ${g.name}${g.plays ? ` and its ${g.plays} logged play(s)` : ""}?`)) return;
      await api(`api/games/${delGame}`, { method: "DELETE" });
      toast("Game deleted");
    } else if (refreshGame) {
      e.target.disabled = true;
      await api(`api/games/${refreshGame}/refresh`, { method: "POST" });
      toast("Updated from BoardGameGeek");
    } else return;
    loadAll();
  } catch (err) {
    e.target.disabled = false;
    toast(err.message, true);
  }
});

$("#bgg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#bgg-q").value.trim();
  const out = $("#bgg-results");
  if (q.length < 2) return;
  out.innerHTML = `<div class="muted">Searching BoardGameGeek…</div>`;
  try {
    const results = await api(`api/bgg/search?q=${encodeURIComponent(q)}`);
    const owned = new Set(state.games.map((g) => g.bgg_id).filter(Boolean));
    out.innerHTML = results.length
      ? results
          .map((r) => `
        <div class="item">
          <div class="grow"><b>${esc(r.name)}${r.year ? ` <span class="muted" style="font-weight:400">(${r.year})</span>` : ""}</b></div>
          <a class="btn ghost small" href="https://boardgamegeek.com/boardgame/${r.bgg_id}" target="_blank" rel="noopener">View</a>
          ${owned.has(r.bgg_id)
            ? `<span class="muted" style="font-size:.85rem">In collection</span>`
            : `<button class="btn small" data-add-bgg="${r.bgg_id}">Add</button>`}
        </div>`)
          .join("")
      : `<div class="muted">No matches on BoardGameGeek.</div>`;
  } catch (err) {
    out.innerHTML = `<div class="muted">${esc(err.message)} You can still add the game manually below.</div>`;
  }
});

$("#bgg-results").addEventListener("click", async (e) => {
  const id = e.target.dataset.addBgg;
  if (!id) return;
  e.target.disabled = true;
  e.target.textContent = "Adding…";
  try {
    const info = await api(`api/bgg/thing/${id}`);
    await api("api/games", { method: "POST", body: info });
    e.target.outerHTML = `<span class="muted" style="font-size:.85rem">Added ✓</span>`;
    toast(`${info.name} added to the collection`);
    loadAll();
  } catch (err) {
    e.target.disabled = false;
    e.target.textContent = "Add";
    toast(err.message, true);
  }
});

$("#manual-game-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("api/games", {
      method: "POST",
      body: { name: f.name.value, year: f.year.value ? Number(f.year.value) : null, image: f.image.value || null, thumbnail: f.image.value || null },
    });
    f.reset();
    toast("Game added");
    loadAll();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Players ----------
function renderPlayers() {
  $("#players-list").innerHTML = state.players.length
    ? state.players
        .map((p) => `
      <div class="item">
        <input type="color" value="${esc(p.color)}" data-color-player="${p.id}" title="Change colour">
        <div class="grow"><b>${esc(p.name)}</b></div>
        <button class="btn danger small" data-del-player="${p.id}">Delete</button>
      </div>`)
        .join("")
    : `<div class="muted">No players yet.</div>`;
  // Suggest the next unused colour for new players.
  const used = new Set(state.players.map((p) => p.color.toLowerCase()));
  $("#player-form").color.value = PALETTE.find((c) => !used.has(c)) || PALETTE[state.players.length % PALETTE.length];
}

$("#player-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("api/players", { method: "POST", body: { name: f.name.value, color: f.color.value } });
    toast(`${f.name.value} added`);
    f.name.value = "";
    loadAll();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#players-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.delPlayer;
  if (!id) return;
  const p = state.players.find((x) => String(x.id) === id);
  if (!confirm(`Delete ${p.name}? Their results will be removed from all plays.`)) return;
  await api(`api/players/${id}`, { method: "DELETE" });
  toast("Player deleted");
  loadAll();
});

$("#players-list").addEventListener("change", async (e) => {
  const id = e.target.dataset.colorPlayer;
  if (!id) return;
  const p = state.players.find((x) => String(x.id) === id);
  await api(`api/players/${id}`, { method: "PUT", body: { name: p.name, color: e.target.value } });
  toast("Colour updated");
  loadAll();
});

loadAll().catch((err) => toast(err.message, true));
