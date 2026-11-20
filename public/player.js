// Stats page for one player: player?id=<id>
const playerId = Number(new URLSearchParams(location.search).get("id"));

const pct = (w, n) => (n ? Math.round((w / n) * 100) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderHeader({ player, totals }) {
  document.title = `${player.name} · Player Stats`;
  document.getElementById("name").innerHTML =
    `<span class="dot big" style="background:${esc(player.color)}"></span>${esc(player.name)}`;
  document.getElementById("subtitle").textContent = totals.plays
    ? `Played since ${fmtDate(totals.first_played, { month: "long", year: "numeric" })} · last game ${relDate(totals.last_played).toLowerCase()}`
    : "No games logged yet";
}

function renderTotals(t) {
  const streak = t.current_streak
    ? `${t.current_streak.count} ${t.current_streak.type === "W" ? (t.current_streak.count === 1 ? "win" : "wins") : (t.current_streak.count === 1 ? "loss" : "losses")}`
    : "–";
  const tiles = [
    [`${pct(t.wins, t.plays)}%`, "Win rate"],
    [t.wins, "Wins", "w"],
    [t.losses, "Losses", "l"],
    [t.plays, "Played"],
    [t.rank ? `#${t.rank}` : "–", t.rank ? `of ${t.ranked_players} on the board` : "Rank"],
    [t.best_streak, "Best win streak"],
    [streak, "Current streak", t.current_streak?.type === "W" ? "w" : t.current_streak ? "l" : ""],
  ];
  return `
    <section class="panel">
      <div class="p-tiles">${tiles
        .map(([v, label, cls]) => `<div class="p-tile"><b class="${cls || ""}">${v}</b><small>${esc(label)}</small></div>`)
        .join("")}</div>
      <div class="wl-bar big"><i style="width:${pct(t.wins, t.plays)}%"></i></div>
    </section>`;
}

function renderGames(games) {
  if (!games.length) return "";
  const row = (g) => `
    <div class="p-game">
      ${thumb(g.id, g.thumbnail || g.image, g.name)}
      <div style="min-width:0">
        <div class="play-top"><b>${esc(g.name)}</b><span class="rate">${pct(g.wins, g.plays)}%</span></div>
        <div class="wl-bar"><i style="width:${pct(g.wins, g.plays)}%"></i></div>
        <div class="leader-meta">
          <span class="w">${g.wins} W</span><span class="l">${g.losses} L</span>
          <span>${plural(g.plays, "play")}</span>
          ${g.best_score != null ? `<span>best score ${g.best_score}</span>` : ""}
          <span>last ${relDate(g.last_played).toLowerCase()}</span>
        </div>
      </div>
    </div>`;
  const won = games.filter((g) => g.wins > 0).sort((a, b) => b.wins - a.wins || a.losses - b.losses);
  const never = games.filter((g) => g.wins === 0);
  return `
    <section class="panel">
      <h2>Games won <small>${plural(won.length, "game")}</small></h2>
      ${won.length ? `<div class="recent">${won.map(row).join("")}</div>` : `<div class="empty">No wins yet – the next one is surely coming.</div>`}
    </section>
    ${never.length ? `
    <section class="panel">
      <h2>Not won yet <small>${plural(never.length, "game")}</small></h2>
      <div class="recent">${never.map(row).join("")}</div>
    </section>` : ""}`;
}

function renderRivals(rivals) {
  if (!rivals.length) return "";
  return `
    <section class="panel">
      <h2>Head to head <small>wins – losses against each player</small></h2>
      <div class="recent">${rivals
        .map((r) => `
        <a class="p-rival" href="player?id=${r.id}">
          <span class="dot" style="background:${esc(r.color)}"></span>
          <b>${esc(r.name)}</b>
          <span class="muted">${plural(r.plays, "game")} together</span>
          <span class="score"><span class="w">${r.wins}</span> – <span class="l">${r.losses}</span></span>
        </a>`)
        .join("")}</div>
    </section>`;
}

function renderHistory(plays) {
  if (!plays.length) return "";
  return `
    <section class="panel">
      <h2>All games played <small>newest first</small></h2>
      <div class="recent">${plays
        .map((p) => {
          const me = p.players.find((x) => x.player_id === playerId);
          return `
          <div class="play-row">
            ${thumb(p.game_id, p.thumbnail || p.image, p.game_name)}
            <div style="min-width:0">
              <div class="play-top">
                <b>${esc(p.game_name)}</b>
                <time datetime="${esc(p.played_at)}">${relDate(p.played_at)}</time>
              </div>
              <div class="chips">
                <span class="result ${me?.winner ? "W" : "L"}">${me?.winner ? "Won" : "Lost"}</span>
                ${p.players
                  .map((pl) => `<a href="player?id=${pl.player_id}" class="chip ${pl.winner ? "win" : ""} ${pl.player_id === playerId ? "me" : ""}"><span class="dot" style="background:${esc(pl.color)}"></span>${pl.winner ? "♛ " : ""}${esc(pl.name)}${pl.score != null ? ` · ${pl.score}` : ""}</a>`)
                  .join("")}
              </div>
            </div>
          </div>`;
        })
        .join("")}</div>
    </section>`;
}

async function load() {
  const content = document.getElementById("content");
  if (!playerId) {
    document.getElementById("subtitle").innerHTML = `No player picked. <a href="./">Back to the scoreboard</a>`;
    return;
  }
  try {
    const s = await api(`api/players/${playerId}/stats`);
    renderHeader(s);
    if (!s.totals.plays) {
      content.innerHTML = `<section class="panel empty">${esc(s.player.name)} hasn't played any logged games yet.</section>`;
      return;
    }
    content.innerHTML = `
      ${renderTotals(s.totals)}
      <div class="grid-main">
        <div class="stack">${renderGames(s.games)}</div>
        <div class="stack">${renderRivals(s.rivals)}${renderHistory(s.plays)}</div>
      </div>`;
  } catch (err) {
    document.getElementById("subtitle").textContent = `Could not load player: ${err.message}`;
  }
}

load();
