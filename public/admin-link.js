// "Link to BoardGameGeek": find BGG entries for games that were added by hand,
// let the user review the matches, then copy the details in.
// Uses state, api, toast, esc, loadAll from admin.js / common.js.

const link = {
  phase: "idle", // idle | searching | review | linking
  rows: new Map(), // game_id -> { game, result, pick, include, error }
  order: [],
  done: 0,
  stop: false,
};

const CONF_LABEL = { sure: "Sure match", guess: "Please check", none: "Not found" };

function unlinkedGames() {
  // Base games first, so expansions are matched after their game.
  const bases = state.games.filter((g) => !g.bgg_id && !g.parent_id);
  const exps = state.games.filter((g) => !g.bgg_id && g.parent_id);
  return [...bases, ...exps];
}

function baseName(g) {
  return g.parent_id ? state.games.find((x) => x.id === g.parent_id)?.name : null;
}

function renderLinkPanel() {
  const panel = document.getElementById("link-panel");
  if (link.phase === "idle") {
    const todo = unlinkedGames();
    panel.hidden = !todo.length;
    if (!todo.length) return;
    const bases = todo.filter((g) => !g.parent_id).length;
    const exps = todo.length - bases;
    const minutes = Math.max(1, Math.round((todo.length * 2 * 1.3) / 60));
    panel.innerHTML = `
      <h2>Link your games to BoardGameGeek</h2>
      <p class="muted" style="margin:0 0 14px;line-height:1.5">
        ${[bases && `${bases} game${bases === 1 ? "" : "s"}`, exps && `${exps} expansion${exps === 1 ? "" : "s"}`].filter(Boolean).join(" and ")}
        ${todo.length === 1 ? "isn't" : "aren't"} linked to BoardGameGeek yet. Linking fills in player count, playing time, age,
        complexity, type, category, mechanism, designers and description.
        Your own names, years, editions and pictures stay as they are.
      </p>
      <p class="muted" style="margin:0 0 14px;font-size:.88rem">You'll review the matches before anything is changed. Searching takes about ${minutes} minute${minutes === 1 ? "" : "s"}.</p>
      <button class="btn" id="link-start">Find matches</button>`;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <h2 id="link-head"></h2>
    <div id="link-status"></div>
    <p class="muted" style="margin:0 0 12px;font-size:.88rem">
      Sure matches are ticked for you. Check the others: pick the right entry from the list, or search with another name.
    </p>
    <div class="link-rows" id="link-rows">${link.order.map(rowHtml).join("")}</div>
    <div class="row" style="margin-top:14px" id="link-foot"></div>`;
  renderLinkChrome();
}

// Header counts, progress and buttons; updated without touching the rows.
function renderLinkChrome() {
  const total = link.order.length;
  const selected = link.order.filter((id) => link.rows.get(id).include && link.rows.get(id).pick).length;
  const counts = { sure: 0, guess: 0, none: 0 };
  link.order.forEach((id) => { const r = link.rows.get(id).result; if (r) counts[r.confidence]++; });
  document.getElementById("link-head").innerHTML = `Link your games to BoardGameGeek
    <small>${counts.sure} sure · ${counts.guess} to check · ${counts.none} not found</small>`;
  document.getElementById("link-status").innerHTML =
    link.phase === "searching"
      ? `<div class="link-progress"><div class="bar"><i style="width:${total ? (link.done / total) * 100 : 0}%"></i></div>
          <span>Searching BoardGameGeek… ${link.done} of ${total}</span>
          <button class="btn ghost small" id="link-stop">Stop</button></div>`
      : link.phase === "linking"
        ? `<div class="link-progress"><span>Copying details from BoardGameGeek…</span></div>`
        : "";
  document.getElementById("link-foot").innerHTML = `
    <button class="btn" id="link-apply" ${selected && link.phase !== "linking" ? "" : "disabled"}>Link ${selected} selected</button>
    <button class="btn ghost" id="link-cancel" ${link.phase === "linking" ? "disabled" : ""}>${link.phase === "searching" ? "Cancel" : "Close"}</button>`;
}

function rowHtml(id) {
  const row = link.rows.get(id);
  const g = row.game;
  const base = baseName(g);
  const r = row.result;
  let pick;
  if (row.error) pick = `<span class="muted">${esc(row.error)}</span>`;
  else if (!r) pick = `<span class="muted">Waiting…</span>`;
  else if (row.searching) pick = `<span class="muted">Searching…</span>`;
  else {
    const options = r.candidates.map((c) =>
      `<option value="${c.bgg_id}" ${c.bgg_id === row.pick ? "selected" : ""}>${esc(c.name)}${c.year ? ` (${c.year})` : ""}</option>`).join("");
    pick = `
      ${r.candidates.length ? `<select data-link-pick="${id}" aria-label="BoardGameGeek match for ${esc(g.name)}">
        ${options}<option value="" ${row.pick ? "" : "selected"}>— Don't link —</option></select>` : ""}
      ${row.pick ? `<a class="btn ghost small" href="https://boardgamegeek.com/boardgame/${row.pick}" target="_blank" rel="noopener">View</a>` : ""}
      ${r.confidence === "sure" && !row.showRetry
        ? `<button class="link-btn" type="button" data-link-show-retry="${id}">Wrong game?</button>`
        : `<form class="link-retry" data-link-retry="${id}">
            <input type="text" name="q" value="${esc(r.query)}" aria-label="Search with another name">
            <button class="btn ghost small" type="submit">Search again</button>
          </form>`}`;
  }
  const conf = r ? `<span class="conf conf-${r.confidence}">${CONF_LABEL[r.confidence]}</span>` : "";
  return `
    <div class="link-row ${row.include && row.pick ? "on" : ""}" data-row="${id}">
      <input type="checkbox" data-link-include="${id}" ${row.include && row.pick ? "checked" : ""} ${row.pick ? "" : "disabled"} aria-label="Link ${esc(g.name)}">
      <div class="link-ours">
        <b>${esc(g.name)}</b>${g.year ? ` <span class="muted">(${g.year})</span>` : ""}
        ${base ? `<div class="muted" style="font-size:.8rem">Expansion for ${esc(base)}</div>` : ""}
        ${conf}
      </div>
      <div class="link-pick">${pick}</div>
    </div>`;
}

function updateRow(id) {
  const el = document.querySelector(`[data-row="${id}"]`);
  if (el) el.outerHTML = rowHtml(id);
  renderLinkChrome();
}

async function matchRow(id, q) {
  const row = link.rows.get(id);
  try {
    const res = await api(`api/bgg/match/${id}${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    row.result = res;
    row.pick = res.best;
    row.include = res.confidence === "sure" || (!!q && !!res.best);
    row.error = null;
  } catch (err) {
    row.error = err.message;
  }
  row.searching = false;
}

async function startLinking() {
  const todo = unlinkedGames();
  link.phase = "searching";
  link.stop = false;
  link.done = 0;
  link.order = todo.map((g) => g.id);
  link.rows = new Map(todo.map((g) => [g.id, { game: g, result: null, pick: null, include: false }]));
  renderLinkPanel();
  for (const id of link.order) {
    if (link.stop) break;
    await matchRow(id);
    link.done++;
    // If BGG refuses us outright (bad token), stop instead of failing every game.
    if (/refused|BGG_TOKEN/i.test(link.rows.get(id).error || "")) {
      toast(link.rows.get(id).error, true);
      break;
    }
    updateRow(id);
  }
  // After "Stop", forget the games that were never searched.
  link.order = link.order.filter((id) => link.rows.get(id).result || link.rows.get(id).error);
  link.phase = link.order.length ? "review" : "idle";
  renderLinkPanel();
}

async function applyLinks() {
  const chosen = link.order
    .map((id) => link.rows.get(id))
    .filter((r) => r.include && r.pick)
    .map((r) => ({ game_id: r.game.id, bgg_id: r.pick }));
  if (!chosen.length) return;
  link.phase = "linking";
  renderLinkPanel();
  let linked = 0;
  const failed = [];
  try {
    for (let i = 0; i < chosen.length; i += 20) {
      const res = await api("api/games/link", { method: "POST", body: { links: chosen.slice(i, i + 20) } });
      linked += res.linked.length;
      failed.push(...res.failed);
      for (const id of res.linked) {
        link.rows.delete(id);
        link.order = link.order.filter((x) => x !== id);
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
  for (const f of failed) {
    const row = link.rows.get(f.game_id);
    if (row) row.error = f.error;
  }
  link.phase = link.order.length ? "review" : "idle";
  toast(`Linked ${linked} game${linked === 1 ? "" : "s"} to BoardGameGeek${failed.length ? ` · ${failed.length} failed` : ""}`, !!failed.length);
  await loadAll();
}

document.getElementById("link-panel").addEventListener("click", (e) => {
  const showRetry = e.target.dataset.linkShowRetry;
  if (showRetry) {
    link.rows.get(Number(showRetry)).showRetry = true;
    updateRow(Number(showRetry));
    document.querySelector(`[data-link-retry="${showRetry}"] input`)?.focus();
  } else if (e.target.id === "link-start") startLinking();
  else if (e.target.id === "link-stop") link.stop = true;
  else if (e.target.id === "link-apply") applyLinks();
  else if (e.target.id === "link-cancel") {
    link.stop = true;
    link.phase = "idle";
    link.rows.clear();
    link.order = [];
    renderLinkPanel();
  }
});

document.getElementById("link-panel").addEventListener("change", (e) => {
  const { linkPick, linkInclude } = e.target.dataset;
  if (linkPick) {
    const row = link.rows.get(Number(linkPick));
    row.pick = e.target.value ? Number(e.target.value) : null;
    row.include = !!row.pick;
    updateRow(Number(linkPick));
  } else if (linkInclude) {
    link.rows.get(Number(linkInclude)).include = e.target.checked;
    updateRow(Number(linkInclude));
  }
});

document.getElementById("link-panel").addEventListener("submit", async (e) => {
  const id = Number(e.target.dataset.linkRetry);
  if (!id) return;
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (!q) return;
  link.rows.get(id).searching = true;
  document.activeElement?.blur();
  updateRow(id);
  await matchRow(id, q);
  updateRow(id);
});
