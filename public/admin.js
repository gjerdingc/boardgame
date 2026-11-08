const PALETTE = ["#f4b860", "#7bd389", "#6cb4ee", "#e76f51", "#c792ea", "#4dd0c8", "#ff8fab", "#f9e07f"];
const state = { players: [], games: [], plays: [], editingId: null, openExpansionsFor: null, bggExpansions: {}, editingGameId: null };
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

const readExpansionPicks = () =>
  new Set([...document.querySelectorAll("#play-expansions input:checked")].map((el) => el.value));

// Checkboxes for the chosen game's expansions (hidden when it has none).
function renderExpansionPicks(checked = readExpansionPicks()) {
  const box = $("#play-expansions");
  const base = state.games.find((g) => String(g.id) === $("#play-game").value);
  const exps = base ? expansionsOf(base.id) : [];
  box.hidden = !exps.length;
  box.innerHTML = exps.length
    ? `<div class="exp-picks-label">Expansions used</div><div class="exp-picks-list">${exps
        .map((x) => `<label class="exp-pick"><input type="checkbox" value="${x.id}" ${checked.has(String(x.id)) ? "checked" : ""}>${esc(shortExpName(x.name, base.name))}${x.year ? ` <span class="muted">${x.year}</span>` : ""}</label>`)
        .join("")}</div>`
    : "";
}

$("#play-game").addEventListener("change", () => renderExpansionPicks(new Set()));

function renderPlayForm(picks = readPicks(), expansionPicks = readExpansionPicks()) {
  const sel = $("#play-game");
  const prev = sel.value;
  const bases = baseGames();
  sel.innerHTML = bases.length
    ? `<option value="">Choose a game…</option>` + bases.map((g) => `<option value="${g.id}">${esc(g.name)}${g.year ? ` (${g.year})` : ""}${g.edition ? ` – ${esc(editionLabel(g.edition))}` : ""}</option>`).join("")
    : `<option value="">Add a game first (Games tab)</option>`;
  if (prev) sel.value = prev;
  if (!$("#play-date").value) $("#play-date").value = today();
  renderExpansionPicks(expansionPicks);

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
  form.dur_h.value = play.duration_min ? Math.floor(play.duration_min / 60) || "" : "";
  form.dur_m.value = play.duration_min ? play.duration_min % 60 || "" : "";
  form.notes.value = play.notes || "";
  renderPlayForm(
    new Map(play.players.map((p) => [String(p.player_id), { winner: p.winner, score: p.score ?? "" }])),
    new Set(play.expansions.map((x) => String(x.id)))
  );
  setEditing(play);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetPlayForm({ keepPlayers }) {
  const form = $("#play-form");
  form.notes.value = "";
  form.dur_h.value = "";
  form.dur_m.value = "";
  if (state.editingId) {
    form.game_id.value = "";
    form.played_at.value = today();
  }
  const picks = keepPlayers ? new Map([...readPicks().keys()].map((id) => [id, { winner: false, score: "" }])) : new Map();
  const wasEditing = !!state.editingId;
  setEditing(null);
  // A new play keeps the same expansions ticked for the next round; after an edit, start clean.
  renderPlayForm(picks, wasEditing ? new Set() : readExpansionPicks());
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
  const h = Number(form.dur_h.value || 0);
  const m = Number(form.dur_m.value || 0);
  if (h < 0 || m < 0 || !Number.isFinite(h + m)) return toast("Duration can't be negative", true);
  const body = {
    duration_min: Math.round(h * 60 + m) || null,
    game_id: Number(form.game_id.value),
    played_at: form.played_at.value,
    notes: form.notes.value,
    players,
    expansions: [...readExpansionPicks()].map(Number),
  };
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
          <b>${esc(p.game_name)} <span class="muted" style="font-weight:400">· ${fmtDate(p.played_at)}${p.duration_min ? ` · ⏱ ${fmtDuration(p.duration_min)}` : ""}</span></b>
          ${p.expansions.length ? `<div class="exp-line">+ ${p.expansions.map((x) => esc(shortExpName(x.name, p.game_name))).join(", ")}</div>` : ""}
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
const baseGames = () => state.games.filter((g) => !g.parent_id);
// Expansions of a game in release order (unknown years last), then by name.
const expansionsOf = (id) =>
  state.games
    .filter((g) => g.parent_id === id)
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name));

function gameMeta(g) {
  return [
    g.min_players ? `${g.min_players}${g.max_players && g.max_players !== g.min_players ? `–${g.max_players}` : ""} players` : null,
    g.playing_time ? `${g.playing_time} min` : null,
    g.rating ? `BGG ${g.rating.toFixed(1)}` : null,
    g.parent_id ? `used in ${g.plays} play${g.plays === 1 ? "" : "s"}` : `${g.plays} play${g.plays === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");
}

function gameButtons(g) {
  return `${g.bgg_id ? `<a class="btn ghost small" href="https://boardgamegeek.com/boardgame/${g.bgg_id}" target="_blank" rel="noopener">BGG</a>
    <button class="btn ghost small" data-refresh-game="${g.id}">Refresh</button>` : ""}
    <button class="btn ghost small" data-edit-game="${g.id}">Edit</button>
    <button class="btn danger small" data-del-game="${g.id}">Delete</button>`;
}

const editionTag = (g) => (g.edition ? ` <span class="edition-tag">${esc(editionLabel(g.edition))}</span>` : "");

// Inline form for changing a game's or expansion's name and release year.
function editGameRow(g, sub) {
  return `
    <form class="item edit-row ${sub ? "sub" : ""}" data-edit-game-form="${g.id}">
      <label class="grow">Name<input type="text" name="name" required value="${esc(g.name)}"></label>
      <label class="year-field">Release year<input type="number" name="year" value="${g.year ?? ""}" placeholder="e.g. 2021"></label>
      <label class="year-field">Edition<input type="text" name="edition" value="${esc(g.edition ?? "")}" placeholder="e.g. 2"></label>
      <label class="grow">Image link<input type="url" name="image" value="${esc(g.image ?? "")}" placeholder="https://… (optional)"></label>
      <button class="btn small" type="submit">Save</button>
      <button class="btn ghost small" type="button" data-cancel-edit-game>Cancel</button>
    </form>`;
}

// Panel for adding expansions under a base game: BGG's list of known expansions + manual entry.
function renderExpansionPanel(base) {
  const owned = new Set(state.games.map((g) => g.bgg_id).filter(Boolean));
  const known = state.bggExpansions[base.id];
  let suggestions = "";
  if (base.bgg_id) {
    if (!known) suggestions = `<div class="muted">Loading expansions from BoardGameGeek…</div>`;
    else if (known.error) suggestions = `<div class="muted">${esc(known.error)} You can still add one by name above.</div>`;
    else if (!known.length) suggestions = `<div class="muted">BoardGameGeek lists no expansions for this game.</div>`;
    else suggestions = `<div class="muted" style="font-size:.85rem">Expansions on BoardGameGeek:</div>` + known
      .map((x) => `
        <div class="item">
          <div class="grow"><b>${esc(shortExpName(x.name, base.name))}</b></div>
          ${owned.has(x.bgg_id)
            ? `<span class="muted" style="font-size:.85rem">Added</span>`
            : `<button class="btn small" data-add-exp-bgg="${x.bgg_id}" data-base="${base.id}">Add</button>`}
        </div>`).join("");
  }
  return `
    <div class="exp-panel">
      <form class="row" data-exp-manual="${base.id}">
        <label>Expansion name<input type="text" name="name" required placeholder="e.g. European Expansion"></label>
        <label class="year-field">Release year<input type="number" name="year" placeholder="e.g. 2021"></label>
        <label>Image link (optional)<input type="url" name="image" placeholder="https://…"></label>
        <button class="btn small" type="submit">Add expansion</button>
      </form>
      <div class="bgg-results">${suggestions}</div>
    </div>`;
}

function renderGames() {
  const bases = baseGames();
  $("#games-list").innerHTML = bases.length
    ? bases
        .map((g) => {
          const exps = expansionsOf(g.id);
          const open = state.openExpansionsFor === g.id;
          return `
      <div class="game-group">
        ${state.editingGameId === g.id ? editGameRow(g, false) : `<div class="item">
          ${thumb(g.id, g.thumbnail || g.image, g.name)}
          <div class="grow">
            <b>${esc(g.name)}${g.year ? ` <span class="muted" style="font-weight:400">(${g.year})</span>` : ""}${editionTag(g)}</b>
            <div class="muted" style="font-size:.85rem">${gameMeta(g)}${exps.length ? ` · ${exps.length} expansion${exps.length === 1 ? "" : "s"}` : ""}</div>
          </div>
          <button class="btn ghost small ${open ? "active" : ""}" data-toggle-exp="${g.id}">+ Expansion</button>
          ${gameButtons(g)}
        </div>`}
        ${exps.map((x) => state.editingGameId === x.id ? editGameRow(x, true) : `
          <div class="item sub">
            ${thumb(x.id, x.thumbnail || x.image, shortExpName(x.name, g.name))}
            <div class="grow">
              <b>${esc(shortExpName(x.name, g.name))}${x.year ? ` <span class="muted" style="font-weight:400">(${x.year})</span>` : ""}${editionTag(x)}</b>
              <div class="muted" style="font-size:.85rem">Expansion · ${x.year ? "" : "release year unknown · "}${gameMeta(x)}</div>
            </div>
            ${gameButtons(x)}
          </div>`).join("")}
        ${open ? renderExpansionPanel(g) : ""}
      </div>`;
        })
        .join("")
    : `<div class="muted">No games yet. Search BoardGameGeek above.</div>`;
}

async function loadBggExpansions(base) {
  if (!base.bgg_id || state.bggExpansions[base.id]) return;
  try {
    const info = await api(`api/bgg/thing/${base.bgg_id}`);
    state.bggExpansions[base.id] = info.expansions || [];
  } catch (err) {
    state.bggExpansions[base.id] = { error: err.message };
  }
  renderGames();
}

$("#games-list").addEventListener("click", async (e) => {
  const { delGame, refreshGame, toggleExp, addExpBgg, editGame } = e.target.dataset;
  if (editGame || "cancelEditGame" in e.target.dataset) {
    state.editingGameId = editGame ? Number(editGame) : null;
    renderGames();
    if (editGame) document.querySelector(`[data-edit-game-form="${editGame}"] input[name=year]`)?.focus();
    return;
  }
  try {
    if (toggleExp) {
      const id = Number(toggleExp);
      state.openExpansionsFor = state.openExpansionsFor === id ? null : id;
      renderGames();
      if (state.openExpansionsFor) {
        document.querySelector(`[data-exp-manual="${id}"] input`)?.focus();
        loadBggExpansions(state.games.find((g) => g.id === id));
      }
      return;
    }
    if (delGame) {
      const g = state.games.find((x) => String(x.id) === delGame);
      const exps = expansionsOf(g.id).length;
      const what = g.parent_id
        ? `expansion ${g.name}? It will be removed from the ${g.plays} play(s) it was used in`
        : `${g.name}${g.plays ? ` and its ${g.plays} logged play(s)` : ""}${exps ? ` and ${exps} expansion(s)` : ""}?`;
      if (!confirm(`Delete ${what}`)) return;
      await api(`api/games/${delGame}`, { method: "DELETE" });
      toast("Deleted");
    } else if (refreshGame) {
      e.target.disabled = true;
      await api(`api/games/${refreshGame}/refresh`, { method: "POST" });
      toast("Updated from BoardGameGeek");
    } else if (addExpBgg) {
      e.target.disabled = true;
      e.target.textContent = "Adding…";
      const info = await api(`api/bgg/thing/${addExpBgg}`);
      await api("api/games", { method: "POST", body: { ...info, parent_id: Number(e.target.dataset.base) } });
      toast(`${info.name} added`);
    } else return;
    loadAll();
  } catch (err) {
    e.target.disabled = false;
    if (addExpBgg) e.target.textContent = "Add";
    toast(err.message, true);
  }
});

$("#games-list").addEventListener("submit", async (e) => {
  const editId = e.target.dataset.editGameForm;
  if (editId) {
    e.preventDefault();
    try {
      await api(`api/games/${editId}`, { method: "PUT", body: { name: e.target.name.value, year: e.target.year.value, edition: e.target.edition.value, image: e.target.image.value } });
      state.editingGameId = null;
      toast("Saved");
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  const baseId = e.target.dataset.expManual;
  if (!baseId) return;
  e.preventDefault();
  try {
    const name = e.target.name.value.trim();
    await api("api/games", { method: "POST", body: { name, year: e.target.year.value, image: e.target.image.value, parent_id: Number(baseId) } });
    toast(`${name} added`);
    await loadAll();
    document.querySelector(`[data-exp-manual="${baseId}"] input`)?.focus();
  } catch (err) {
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
          <div class="grow"><b>${esc(r.name)}${r.year ? ` <span class="muted" style="font-weight:400">(${r.year})</span>` : ""}</b>
            ${r.is_expansion ? `<div class="muted" style="font-size:.8rem">Expansion — added under its base game</div>` : ""}</div>
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
    // The server files an expansion under its base game if that game is in the collection.
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
      body: { name: f.name.value, year: f.year.value ? Number(f.year.value) : null, edition: f.edition.value, image: f.image.value || null, thumbnail: f.image.value || null },
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
