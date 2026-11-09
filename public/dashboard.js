const REFRESH_MS = 60_000;
const RANK_COLORS = ["#f4b860", "#cfd8dc", "#d7a27a"];

function renderTotals(t) {
  const items = [
    [t.plays, "Plays"],
    [t.games, "Games"],
    [t.players, "Players"],
  ];
  document.getElementById("totals").innerHTML = items
    .map(([n, label]) => `<div class="total"><b>${n}</b><small>${label}</small></div>`)
    .join("");
  document.getElementById("subtitle").textContent = t.last_played
    ? `Last game played ${relDate(t.last_played).toLowerCase()} · tracking since ${fmtDate(t.first_played, { month: "long", year: "numeric" })}`
    : "Our board game scoreboard";
}

function renderLeaders(players) {
  const active = players.filter((p) => p.plays > 0);
  if (!active.length) return `<div class="empty">No results yet.</div>`;
  return `<div class="leaders">${active
    .map((p, i) => {
      const pct = Math.round(p.win_rate * 100);
      const top = p.rank === 1 && p.wins > 0;
      const rankBg = RANK_COLORS[p.rank - 1] || "#5f7d74";
      return `
      <div class="leader ${top ? "first" : ""}">
        <div class="rank" style="background:${rankBg}">${p.rank}</div>
        <div style="min-width:0">
          <div class="leader-name">
            <span class="dot" style="background:${esc(p.color)}"></span>
            <span>${esc(p.name)}</span>
            ${top ? `<span class="crown" title="Top of the table">♛</span>` : ""}
          </div>
          <div class="wl-bar"><i style="width:${pct}%"></i></div>
          <div class="leader-meta">
            <span class="w">${p.wins} W</span>
            <span class="l">${p.losses} L</span>
            <span>${p.plays} played</span>
            <span class="form" title="Last ${p.form.length} results, newest first">${p.form.map((r) => `<i class="${r}"></i>`).join("")}</span>
          </div>
        </div>
        <div class="leader-right"><b>${pct}%</b><small>win rate</small></div>
      </div>`;
    })
    .join("")}</div>`;
}

function renderShelf(games) {
  const played = games.filter((g) => g.plays > 0);
  const list = (played.length ? played : games).slice(0, 12);
  if (!list.length) return `<div class="empty">No games yet.</div>`;
  return `<div class="shelf">${list
    .map((g) => `
      <article class="game-card">
        ${g.image || g.thumbnail
          ? `<div class="game-cover" style="background-image:url('covers/${g.id}'), radial-gradient(circle at 30% 20%, #2d5247, #10201b)">`
          : `<div class="game-cover placeholder">${initial(g.name)}`}
          <span class="play-badge">${g.plays}×</span>
        </div>
        <div class="game-info">
          <h3>${esc(g.name)}</h3>
          ${g.edition ? `<div class="edition-tag">${esc(editionLabel(g.edition))}</div>` : ""}
          <div class="sub">${g.last_played ? `Last played ${relDate(g.last_played).toLowerCase()}` : "Not played yet"}${g.expansions ? ` · ${g.expansions} exp.` : ""}</div>
          ${g.champion
            ? `<div class="champ"><span class="crown">♛</span><span class="dot" style="background:${esc(g.champion.color)}"></span>${esc(g.champion.name)} <span class="muted">· ${g.champion.wins} win${g.champion.wins === 1 ? "" : "s"}</span></div>`
            : ""}
        </div>
      </article>`)
    .join("")}</div>`;
}

function renderRecent(recent) {
  if (!recent.length) return `<div class="empty">No plays logged yet.</div>`;
  return `<div class="recent">${recent
    .map((p) => `
      <div class="play-row">
        ${thumb(p.game_id, p.thumbnail || p.image, p.game_name)}
        <div style="min-width:0">
          <div class="play-top"><b>${esc(p.game_name)}</b><time datetime="${esc(p.played_at)}">${relDate(p.played_at)}${p.duration_min ? ` · ⏱ ${fmtDuration(p.duration_min)}` : ""}</time></div>
          ${p.expansions.length ? `<div class="exp-line">+ ${p.expansions.map((x) => esc(shortExpName(x.name, p.game_name))).join(", ")}</div>` : ""}
          <div class="chips">${p.players
            .map((pl) => `<span class="chip ${pl.winner ? "win" : ""}"><span class="dot" style="background:${esc(pl.color)}"></span>${pl.winner ? "♛ " : ""}${esc(pl.name)}${pl.score != null ? ` · ${pl.score}` : ""}</span>`)
            .join("")}</div>
        </div>
      </div>`)
    .join("")}</div>`;
}

function renderMatrix(stats) {
  const players = stats.players.filter((p) => p.plays > 0);
  const games = stats.games.filter((g) => g.plays > 0);
  if (!players.length || !games.length) return "";
  const cell = new Map(stats.matrix.map((m) => [`${m.game_id}:${m.player_id}`, m]));
  return `
    <section class="panel">
      <h2>Head to head <small>wins – losses per game</small></h2>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead><tr><th>Game</th><th>Plays</th>${players.map((p) => `<th><span class="dot" style="display:inline-block;background:${esc(p.color)};margin-right:6px"></span>${esc(p.name)}</th>`).join("")}</tr></thead>
          <tbody>${games
            .map((g) => {
              const best = g.champion?.id;
              return `<tr><td title="${esc(g.name)}">${esc(g.name)}</td><td>${g.plays}</td>${players
                .map((p) => {
                  const m = cell.get(`${g.id}:${p.id}`);
                  if (!m) return `<td class="none">–</td>`;
                  return `<td><span class="${p.id === best ? "best" : ""}" style="padding:4px 8px"><span class="w">${m.wins}</span> – <span class="l">${m.losses}</span></span></td>`;
                })
                .join("")}</tr>`;
            })
            .join("")}</tbody>
        </table>
      </div>
    </section>`;
}

function renderMonthly(monthly) {
  const counts = new Map(monthly.map((m) => [m.month, m.plays]));
  const months = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    months.push({ key, label: m.toLocaleDateString(undefined, { month: "short" }), n: counts.get(key) || 0 });
  }
  const max = Math.max(1, ...months.map((m) => m.n));
  return `
    <section class="panel">
      <h2>Last 12 months <small>${months.reduce((a, m) => a + m.n, 0)} plays</small></h2>
      <div class="months">${months
        .map((m) => `<div class="month" title="${m.n} plays"><div class="bar-area"><i class="${m.n ? "" : "zero"}" style="height:${(m.n / max) * 100}%"></i></div><small>${m.label}</small></div>`)
        .join("")}</div>
    </section>`;
}

const GRID_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>`;

// Gold "Browse our N games" button in the Most played heading.
function browseButton(count) {
  return `<a class="browse-cta" href="games">${GRID_ICON}<span>Browse our <b>${count}</b> game${count === 1 ? "" : "s"}</span><span class="arrow" aria-hidden="true">→</span></a>`;
}

function render(stats) {
  renderTotals(stats.totals);
  const content = document.getElementById("content");
  if (!stats.totals.plays) {
    content.innerHTML = `<section class="panel empty">
      <h2 style="justify-content:center">The table is set</h2>
      <p>No games have been logged yet. <a href="admin">Add players, games and your first play →</a></p>
    </section>`;
    return;
  }
  content.innerHTML = `
    <div class="grid-main">
      <div class="stack">
        <section class="panel"><h2>Leaderboard <small>ranked by wins</small></h2>${renderLeaders(stats.players)}</section>
        <section class="panel"><h2>Recent plays</h2>${renderRecent(stats.recent.slice(0, 8))}</section>
      </div>
      <div class="stack">
        <section class="panel"><h2>Most played ${browseButton(stats.totals.games)}</h2>${renderShelf(stats.games)}</section>
        ${renderMonthly(stats.monthly)}
        ${renderMatrix(stats)}
      </div>
    </div>`;
}

async function load() {
  try {
    render(await api("api/stats"));
  } catch (err) {
    document.getElementById("subtitle").textContent = `Could not load stats: ${err.message}`;
  }
}

load();
setInterval(load, REFRESH_MS);
