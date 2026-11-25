const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { db, tx, DATA_DIR } = require("./db");
const bgg = require("./bgg");
const { rankCandidates } = require("./bggMatch");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Scripts, styles and icons. Open to everyone (the collection page needs them), so nothing in
// here may hold data. Always revalidated, so a redeploy shows up straight away.
app.use("/assets", express.static(path.join(PUBLIC_DIR, "assets"), {
  setHeaders: (res, file) => {
    if (/\.(js|css)$/.test(file)) res.set("Cache-Control", "no-cache");
  },
}));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === "function") {
      out.catch((err) => res.status(err.status || 500).json({ error: err.message }));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------- Who is asking ----------
// The app runs behind the gateway (traefik-lab-lb) with path rules, see the README. The gateway
// decides who reaches which path, and sets X-Auth-Request-Email only for someone signed in with
// Google; it removes any copy a client sends. So the app must never be reachable around the
// gateway (no published port). Admins are the signed-in users listed in ADMIN_EMAILS.
const splitEmails = (v) => String(v || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS = new Set(splitEmails(process.env.ADMIN_EMAILS));
// For running locally without the gateway: pretend to be this user. Ignored in production.
const DEV_USER_EMAIL = process.env.NODE_ENV === "production" ? "" : (process.env.DEV_USER_EMAIL || "").trim().toLowerCase();
if (!ADMIN_EMAILS.size) console.warn("ADMIN_EMAILS is not set: nobody can add or change anything.");

function userOf(req) {
  return String(req.get("X-Auth-Request-Email") || DEV_USER_EMAIL).trim().toLowerCase() || null;
}
const isAdmin = (req) => ADMIN_EMAILS.has(userOf(req) || "");

// Only the admin API changes anything. Every other path is read-only, whatever the gateway does.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.path.startsWith("/api/admin/")) return next();
  res.status(405).json({ error: "Not allowed" });
});

const admin = express.Router();
admin.use((req, res, next) => {
  if (isAdmin(req)) return next();
  const msg = !ADMIN_EMAILS.size ? "No admins are set up (ADMIN_EMAILS)"
    : userOf(req) ? "Your account can't make changes" : "Sign in as an admin to make changes";
  res.status(403).json({ error: msg });
});
app.use("/api/admin", admin);

app.get("/api/me", (req, res) => {
  res.json({ email: userOf(req), admin: isAdmin(req) });
});

// ---------- Pages ----------
const page = (file) => (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(PUBLIC_DIR, file));
app.get("/", page("index.html"));
app.get(["/games", "/games.html"], page("games.html"));
app.get(["/player", "/player.html"], page("player.html"));
app.get(["/admin", "/admin.html"], (req, res, next) => {
  if (isAdmin(req)) return page("admin.html")(req, res, next);
  res.status(403).set("Cache-Control", "no-store").type("html").send(notAdminPage(userOf(req)));
});

function notAdminPage(email) {
  const who = email
    ? `<p>You're signed in as <b>${escHtml(email)}</b>, which can't make changes.</p>
       <p><a href="/oauth2/sign_out" data-rd="/admin">Sign in with another account</a></p>`
    : `<p>Sign in with an admin account to add plays, games and players.</p>
       <p><a class="btn" href="/oauth2/start" data-rd="/admin">Sign in with Google</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1"><title>Manage</title>
  <link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/style.css"></head>
  <body><main class="dash"><section class="panel empty"><h2 style="justify-content:center">Admins only</h2>${who}
  <p><a href="./">← Back to the scoreboard</a></p></section></main>
  <script src="assets/common.js"></script><script>wireAuthLinks();</script></body></html>`;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Players ----------
admin.get("/players", wrap((req, res) => {
  res.json(db.prepare("SELECT * FROM players ORDER BY name").all());
}));

admin.post("/players", wrap((req, res) => {
  const name = String(req.body.name || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : "#f4b860";
  if (!name) throw bad("Name is required");
  if (db.prepare("SELECT 1 FROM players WHERE name = ?").get(name)) throw bad("That player already exists");
  const r = db.prepare("INSERT INTO players (name, color) VALUES (?, ?)").run(name, color);
  res.status(201).json(db.prepare("SELECT * FROM players WHERE id = ?").get(r.lastInsertRowid));
}));

admin.put("/players/:id", wrap((req, res) => {
  const name = String(req.body.name || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : null;
  if (!name) throw bad("Name is required");
  db.prepare("UPDATE players SET name = ?, color = COALESCE(?, color) WHERE id = ?").run(name, color, req.params.id);
  res.json(db.prepare("SELECT * FROM players WHERE id = ?").get(req.params.id));
}));

admin.delete("/players/:id", wrap((req, res) => {
  db.prepare("DELETE FROM players WHERE id = ?").run(req.params.id);
  res.status(204).end();
}));

// ---------- Games ----------
const GAME_FIELDS = [
  "name", "bgg_id", "year", "image", "thumbnail", "min_players", "max_players", "playing_time",
  "min_age", "rating", "weight", "categories", "mechanics", "designers", "description", "types",
];

// Details that always come from BGG when a game is linked or refreshed.
const BGG_INFO_FIELDS = [
  "min_players", "max_players", "playing_time", "min_age", "rating", "weight",
  "categories", "mechanics", "designers", "description", "types",
];

// Link a game to a BGG entry and copy its details in. Our own name, edition and
// picture are kept; year and picture are only filled in when we have none.
function applyBggInfo(game, info) {
  const sets = BGG_INFO_FIELDS.map((f) => `${f} = ?`);
  const values = BGG_INFO_FIELDS.map((f) => info[f] ?? null);
  sets.push("bgg_id = ?");
  values.push(info.bgg_id);
  if (!game.year && info.year) { sets.push("year = ?"); values.push(info.year); }
  if (!game.image && info.image) {
    sets.push("image = ?", "thumbnail = ?");
    values.push(info.image, info.thumbnail || info.image);
    clearCover(game.id);
  }
  db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = ?`).run(...values, game.id);
}

// All games, base games and expansions alike. Expansions have parent_id set;
// their "plays" count is how many plays they were used in.
admin.get("/games", wrap((req, res) => {
  res.json(db.prepare(`
    SELECT g.*,
      CASE WHEN g.parent_id IS NULL
        THEN (SELECT COUNT(*) FROM plays p WHERE p.game_id = g.id)
        ELSE (SELECT COUNT(*) FROM play_expansions pe WHERE pe.expansion_id = g.id)
      END AS plays
    FROM games g ORDER BY g.name COLLATE NOCASE`).all());
}));

// Work out which base game a new game belongs under, or null for a base game.
function resolveParent(body) {
  if (body.parent_id) {
    const parent = db.prepare("SELECT id, parent_id FROM games WHERE id = ?").get(body.parent_id);
    if (!parent) throw bad("The base game for this expansion no longer exists");
    if (parent.parent_id) throw bad("An expansion can't have its own expansions");
    return parent.id;
  }
  if (body.is_expansion) {
    const bases = Array.isArray(body.base_games) ? body.base_games : [];
    const find = db.prepare("SELECT id FROM games WHERE bgg_id = ? AND parent_id IS NULL");
    for (const b of bases) {
      const local = find.get(b.bgg_id);
      if (local) return local.id;
    }
    const names = bases.map((b) => b.name).slice(0, 3).join(" or ");
    throw bad(`This is an expansion${names ? ` for ${names}` : ""}. Add the base game first, then add the expansion under it.`);
  }
  return null;
}

admin.post("/games", wrap((req, res) => {
  const g = {};
  for (const f of GAME_FIELDS) g[f] = req.body[f] === "" || req.body[f] === undefined ? null : req.body[f];
  g.name = String(g.name || "").trim();
  if (!g.name) throw bad("Game name is required");
  g.year = parseYear(g.year);
  g.image = parseImageUrl(g.image);
  g.thumbnail = g.thumbnail ? parseImageUrl(g.thumbnail) : g.image;
  if (g.bgg_id && db.prepare("SELECT 1 FROM games WHERE bgg_id = ?").get(g.bgg_id)) {
    throw bad("That game is already in the collection");
  }
  const parentId = resolveParent(req.body);
  // edition is kept out of GAME_FIELDS so a BGG refresh never overwrites it.
  const cols = [...GAME_FIELDS, "parent_id", "edition"];
  const r = db.prepare(
    `INSERT INTO games (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  ).run(...GAME_FIELDS.map((f) => g[f]), parentId, parseEdition(req.body.edition));
  res.status(201).json(db.prepare("SELECT * FROM games WHERE id = ?").get(r.lastInsertRowid));
}));

function parseYear(v) {
  if (v === "" || v == null) return null;
  const y = Number(v);
  if (!Number.isInteger(y) || y < -4000 || y > 2200) throw bad("Year must be a whole year, like 2021");
  return y;
}

function parseEdition(v) {
  const ed = String(v ?? "").trim();
  if (!ed) return null;
  if (ed.length > 40) throw bad("Edition is too long — keep it short, like 2 or Revised");
  return ed;
}

function parseImageUrl(v) {
  const url = String(v ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\/\S+$/i.test(url)) throw bad("Image link must be a web address starting with http:// or https://");
  return url;
}

// Edit a game's or an expansion's name, release year and (optionally) image link.
admin.put("/games/:id", wrap((req, res) => {
  const game = db.prepare("SELECT id, image FROM games WHERE id = ?").get(req.params.id);
  if (!game) return res.status(404).json({ error: "That game no longer exists" });
  const name = String(req.body.name || "").trim();
  if (!name) throw bad("Name is required");
  const year = parseYear(req.body.year);
  tx(() => {
    db.prepare("UPDATE games SET name = ?, year = ? WHERE id = ?").run(name, year, game.id);
    if ("edition" in req.body) {
      db.prepare("UPDATE games SET edition = ? WHERE id = ?").run(parseEdition(req.body.edition), game.id);
    }
    if ("image" in req.body) {
      const image = parseImageUrl(req.body.image);
      if (image !== game.image) {
        db.prepare("UPDATE games SET image = ?, thumbnail = ? WHERE id = ?").run(image, image, game.id);
        clearCover(game.id);
      }
    }
  });
  res.json(db.prepare("SELECT * FROM games WHERE id = ?").get(game.id));
}));

admin.delete("/games/:id", wrap((req, res) => {
  const ids = [Number(req.params.id), ...db.prepare("SELECT id FROM games WHERE parent_id = ?").all(req.params.id).map((r) => r.id)];
  db.prepare("DELETE FROM games WHERE id = ?").run(req.params.id); // expansions cascade
  ids.forEach(clearCover);
  res.status(204).end();
}));

// Re-fetch info from BoardGameGeek for a game already in the collection.
admin.post("/games/:id/refresh", wrap(async (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(req.params.id);
  if (!game?.bgg_id) throw bad("This game is not linked to BoardGameGeek");
  const info = await bgg.thing(game.bgg_id);
  if (!info) throw bad("Not found on BoardGameGeek");
  applyBggInfo(game, info);
  res.json(db.prepare("SELECT * FROM games WHERE id = ?").get(game.id));
}));

// ---------- Linking hand-added games to BoardGameGeek ----------

// Find likely BGG entries for one of our games. ?q= searches with a different name.
admin.get("/bgg/match/:id", wrap(async (req, res) => {
  const game = db.prepare("SELECT id, name, year, parent_id FROM games WHERE id = ?").get(req.params.id);
  if (!game) return res.status(404).json({ error: "That game no longer exists" });
  const base = game.parent_id ? db.prepare("SELECT name FROM games WHERE id = ?").get(game.parent_id) : null;
  const q = String(req.query.q || game.name).trim();
  const type = game.parent_id ? "boardgameexpansion" : "boardgame";
  const takenIds = new Set(
    db.prepare("SELECT bgg_id FROM games WHERE bgg_id IS NOT NULL AND id != ?").all(game.id).map((r) => r.bgg_id)
  );
  const opts = { baseName: base?.name, takenIds };
  const target = { ...game, name: q };

  // Exact-name search first; widen only if that finds nothing convincing.
  let results = await bgg.search(q, { exact: true, type });
  let ranked = rankCandidates(target, results, opts);
  if (ranked.confidence !== "sure" && base) {
    results = results.concat(await bgg.search(`${base.name}: ${q}`, { exact: true, type }));
    ranked = rankCandidates(target, results, opts);
  }
  if (ranked.confidence === "none") {
    results = results.concat(await bgg.search(base ? `${base.name} ${q}` : q, { type }));
    ranked = rankCandidates(target, results, opts);
  }
  res.json({ game_id: game.id, query: q, ...ranked });
}));

// Link several games at once: { links: [{ game_id, bgg_id }] }.
admin.post("/games/link", wrap(async (req, res) => {
  const links = (Array.isArray(req.body.links) ? req.body.links : []).slice(0, 100)
    .map((l) => ({ game_id: Number(l.game_id), bgg_id: Number(l.bgg_id) }))
    .filter((l) => l.game_id && l.bgg_id);
  if (!links.length) throw bad("Nothing to link");
  const infos = new Map((await bgg.things([...new Set(links.map((l) => l.bgg_id))])).map((i) => [i.bgg_id, i]));
  const linked = [];
  const failed = [];
  for (const l of links) {
    const game = db.prepare("SELECT * FROM games WHERE id = ?").get(l.game_id);
    const other = db.prepare("SELECT name FROM games WHERE bgg_id = ? AND id != ?").get(l.bgg_id, l.game_id);
    const info = infos.get(l.bgg_id);
    if (!game) failed.push({ ...l, error: "Game no longer exists" });
    else if (other) failed.push({ ...l, error: `Already linked to ${other.name}` });
    else if (!info) failed.push({ ...l, error: "Not found on BoardGameGeek" });
    else {
      applyBggInfo(game, info);
      linked.push(l.game_id);
    }
  }
  res.json({ linked, failed });
}));

// ---------- BoardGameGeek lookup ----------
admin.get("/bgg/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  res.json(await bgg.search(q));
}));

admin.get("/bgg/thing/:id", wrap(async (req, res) => {
  const info = await bgg.thing(req.params.id);
  if (!info) return res.status(404).json({ error: "Not found on BoardGameGeek" });
  res.json(info);
}));

// ---------- Plays ----------
function playsWithPlayers(rows) {
  const pp = db.prepare(`
    SELECT pp.play_id, pp.player_id, pp.winner, pp.score, pl.name, pl.color
    FROM play_players pp JOIN players pl ON pl.id = pp.player_id
    WHERE pp.play_id = ? ORDER BY pp.winner DESC, pp.score DESC, pl.name`);
  const ex = db.prepare(`
    SELECT g.id, g.name FROM play_expansions pe JOIN games g ON g.id = pe.expansion_id
    WHERE pe.play_id = ? ORDER BY g.name COLLATE NOCASE`);
  return rows.map((r) => ({
    ...r,
    players: pp.all(r.id).map((p) => ({ ...p, winner: !!p.winner })),
    expansions: ex.all(r.id),
  }));
}

admin.get("/plays", wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db.prepare(`
    SELECT p.*, g.name AS game_name, g.thumbnail FROM plays p JOIN games g ON g.id = p.game_id
    ORDER BY p.played_at DESC, p.id DESC LIMIT ?`).all(limit);
  res.json(playsWithPlayers(rows));
}));

function validatePlay(body) {
  const { game_id, played_at, notes } = body;
  const players = Array.isArray(body.players) ? body.players : [];
  if (!db.prepare("SELECT 1 FROM games WHERE id = ? AND parent_id IS NULL").get(game_id)) throw bad("Pick a game");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(played_at || "")) throw bad("Pick a date");
  if (players.length === 0) throw bad("Add at least one player");
  const expansions = [...new Set((Array.isArray(body.expansions) ? body.expansions : []).map(Number))];
  const isOwnExpansion = db.prepare("SELECT 1 FROM games WHERE id = ? AND parent_id = ?");
  for (const id of expansions) {
    if (!isOwnExpansion.get(id, game_id)) throw bad("One of the ticked expansions doesn't belong to this game");
  }
  let duration = body.duration_min;
  if (duration === "" || duration == null || Number(duration) === 0) duration = null;
  else {
    duration = Number(duration);
    if (!Number.isInteger(duration) || duration < 1 || duration > 48 * 60) {
      throw bad("Duration must be between 1 minute and 48 hours");
    }
  }
  return { game_id, played_at, notes: notes ? String(notes) : null, players, expansions, duration };
}

function savePlayExpansions(playId, expansions) {
  db.prepare("DELETE FROM play_expansions WHERE play_id = ?").run(playId);
  const ins = db.prepare("INSERT INTO play_expansions (play_id, expansion_id) VALUES (?, ?)");
  for (const id of expansions) ins.run(playId, id);
}

function savePlayPlayers(playId, players) {
  db.prepare("DELETE FROM play_players WHERE play_id = ?").run(playId);
  const ins = db.prepare("INSERT INTO play_players (play_id, player_id, winner, score) VALUES (?, ?, ?, ?)");
  for (const p of players) {
    const score = p.score === "" || p.score == null || isNaN(Number(p.score)) ? null : Number(p.score);
    ins.run(playId, p.player_id, p.winner ? 1 : 0, score);
  }
}

admin.post("/plays", wrap((req, res) => {
  const play = validatePlay(req.body);
  const id = tx(() => {
    const r = db.prepare("INSERT INTO plays (game_id, played_at, notes, duration_min) VALUES (?, ?, ?, ?)")
      .run(play.game_id, play.played_at, play.notes, play.duration);
    savePlayPlayers(r.lastInsertRowid, play.players);
    savePlayExpansions(r.lastInsertRowid, play.expansions);
    return r.lastInsertRowid;
  });
  res.status(201).json({ id: Number(id) });
}));

admin.put("/plays/:id", wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT 1 FROM plays WHERE id = ?").get(id)) {
    return res.status(404).json({ error: "That play no longer exists" });
  }
  const play = validatePlay(req.body);
  tx(() => {
    db.prepare("UPDATE plays SET game_id = ?, played_at = ?, notes = ?, duration_min = ? WHERE id = ?")
      .run(play.game_id, play.played_at, play.notes, play.duration, id);
    savePlayPlayers(id, play.players);
    savePlayExpansions(id, play.expansions);
  });
  res.json({ id });
}));

admin.delete("/plays/:id", wrap((req, res) => {
  db.prepare("DELETE FROM plays WHERE id = ?").run(req.params.id);
  res.status(204).end();
}));

// ---------- Stats for the dashboard ----------
app.get("/api/stats", wrap((req, res) => {
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM plays) AS plays,
           (SELECT COUNT(*) FROM games WHERE parent_id IS NULL) AS games,
           (SELECT COUNT(*) FROM games WHERE parent_id IS NOT NULL) AS expansions,
           (SELECT COUNT(*) FROM players) AS players,
           (SELECT MAX(played_at) FROM plays) AS last_played,
           (SELECT MIN(played_at) FROM plays) AS first_played`).get();

  const players = db.prepare(`
    SELECT pl.id, pl.name, pl.color,
           COUNT(pp.play_id) AS plays,
           COALESCE(SUM(pp.winner), 0) AS wins,
           COUNT(pp.play_id) - COALESCE(SUM(pp.winner), 0) AS losses
    FROM players pl LEFT JOIN play_players pp ON pp.player_id = pl.id
    GROUP BY pl.id
    ORDER BY wins DESC, (CAST(wins AS REAL) / MAX(plays, 1)) DESC, pl.name`).all()
    .map((p) => ({ ...p, win_rate: p.plays ? p.wins / p.plays : 0 }));

  // Shared rank for ties (same wins and same win rate).
  players.forEach((p, i) => {
    const prev = players[i - 1];
    p.rank = prev && prev.wins === p.wins && prev.win_rate === p.win_rate ? prev.rank : i + 1;
  });

  // Recent form: last 5 results per player (W/L), newest first.
  const formStmt = db.prepare(`
    SELECT pp.winner FROM play_players pp JOIN plays p ON p.id = pp.play_id
    WHERE pp.player_id = ? ORDER BY p.played_at DESC, p.id DESC LIMIT 5`);
  for (const p of players) p.form = formStmt.all(p.id).map((r) => (r.winner ? "W" : "L"));

  const games = db.prepare(`
    SELECT g.id, g.name, g.year, g.edition, g.image, g.thumbnail, g.min_players, g.max_players, g.playing_time, g.rating,
           COUNT(p.id) AS plays, MAX(p.played_at) AS last_played,
           (SELECT COUNT(*) FROM games e WHERE e.parent_id = g.id) AS expansions
    FROM games g LEFT JOIN plays p ON p.game_id = g.id
    WHERE g.parent_id IS NULL
    GROUP BY g.id ORDER BY plays DESC, last_played DESC, g.name`).all();

  // Per game × player results.
  const matrix = db.prepare(`
    SELECT p.game_id, pp.player_id, COUNT(*) AS plays, SUM(pp.winner) AS wins,
           COUNT(*) - SUM(pp.winner) AS losses
    FROM play_players pp JOIN plays p ON p.id = pp.play_id
    GROUP BY p.game_id, pp.player_id`).all();

  // Champion per game = most wins (ties broken by win rate).
  for (const g of games) {
    const rows = matrix.filter((m) => m.game_id === g.id && m.wins > 0)
      .sort((a, b) => b.wins - a.wins || b.wins / b.plays - a.wins / a.plays);
    const champ = rows[0] && players.find((p) => p.id === rows[0].player_id);
    g.champion = champ ? { id: champ.id, name: champ.name, color: champ.color, wins: rows[0].wins } : null;
  }

  const recent = playsWithPlayers(db.prepare(`
    SELECT p.*, g.name AS game_name, g.thumbnail, g.image FROM plays p JOIN games g ON g.id = p.game_id
    ORDER BY p.played_at DESC, p.id DESC LIMIT 12`).all());

  // Plays per month for the last 12 months.
  const monthly = db.prepare(`
    SELECT substr(played_at, 1, 7) AS month, COUNT(*) AS plays FROM plays
    WHERE played_at >= date('now', 'start of month', '-11 months')
    GROUP BY month ORDER BY month`).all();

  res.json({ totals, players, games, matrix, recent, monthly });
}));

// ---------- Stats for one player ----------
app.get("/api/players/:id/stats", wrap((req, res) => {
  const id = Number(req.params.id);
  const player = db.prepare("SELECT id, name, color FROM players WHERE id = ?").get(id);
  if (!player) return res.status(404).json({ error: "That player doesn't exist" });

  const totals = db.prepare(`
    SELECT COUNT(*) AS plays, COALESCE(SUM(pp.winner), 0) AS wins,
           MIN(p.played_at) AS first_played, MAX(p.played_at) AS last_played,
           COUNT(DISTINCT p.game_id) AS games
    FROM play_players pp JOIN plays p ON p.id = pp.play_id
    WHERE pp.player_id = ?`).get(id);
  totals.losses = totals.plays - totals.wins;
  totals.win_rate = totals.plays ? totals.wins / totals.plays : 0;

  // Same ranking as the dashboard leaderboard: wins, then win rate.
  const board = db.prepare(`
    SELECT pl.id, COALESCE(SUM(pp.winner), 0) AS wins, COUNT(pp.play_id) AS plays
    FROM players pl LEFT JOIN play_players pp ON pp.player_id = pl.id GROUP BY pl.id`).all()
    .filter((p) => p.plays > 0)
    .map((p) => ({ ...p, rate: p.wins / p.plays }));
  const me = board.find((p) => p.id === id);
  totals.rank = me ? 1 + board.filter((p) => p.wins > me.wins || (p.wins === me.wins && p.rate > me.rate)).length : null;
  totals.ranked_players = board.length;

  // Win/loss per game.
  const games = db.prepare(`
    SELECT g.id, g.name, g.image, g.thumbnail,
           COUNT(*) AS plays, SUM(pp.winner) AS wins, COUNT(*) - SUM(pp.winner) AS losses,
           MAX(p.played_at) AS last_played, MAX(pp.score) AS best_score
    FROM play_players pp JOIN plays p ON p.id = pp.play_id JOIN games g ON g.id = p.game_id
    WHERE pp.player_id = ?
    GROUP BY g.id
    ORDER BY plays DESC, wins DESC, g.name COLLATE NOCASE`).all(id);

  // Head to head: every opponent this player has shared a table with.
  const rivals = db.prepare(`
    SELECT o.id, o.name, o.color, COUNT(*) AS plays,
           SUM(CASE WHEN me.winner = 1 AND op.winner = 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN op.winner = 1 AND me.winner = 0 THEN 1 ELSE 0 END) AS losses
    FROM play_players me
    JOIN play_players op ON op.play_id = me.play_id AND op.player_id <> me.player_id
    JOIN players o ON o.id = op.player_id
    WHERE me.player_id = ?
    GROUP BY o.id
    ORDER BY plays DESC, o.name COLLATE NOCASE`).all(id);

  const plays = playsWithPlayers(db.prepare(`
    SELECT p.*, g.name AS game_name, g.thumbnail, g.image
    FROM plays p JOIN games g ON g.id = p.game_id JOIN play_players pp ON pp.play_id = p.id
    WHERE pp.player_id = ?
    ORDER BY p.played_at DESC, p.id DESC`).all(id));

  // Longest winning streak and the current streak (W or L), oldest to newest.
  let best = 0, run = 0;
  for (const p of [...plays].reverse()) {
    const won = p.players.find((x) => x.player_id === id)?.winner;
    run = won ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const results = plays.map((p) => p.players.find((x) => x.player_id === id)?.winner);
  let current = 0;
  while (current < results.length && results[current] === results[0]) current++;
  totals.best_streak = best;
  totals.current_streak = results.length ? { type: results[0] ? "W" : "L", count: current } : null;

  res.json({ player, totals, games, rivals, plays });
}));

// ---------- Cover images (cached locally so the dashboard works even if BGG is slow) ----------
const COVER_DIR = path.join(DATA_DIR, "covers");
fs.mkdirSync(COVER_DIR, { recursive: true });

app.get("/covers/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const file = path.join(COVER_DIR, `${id}.img`);
  const send = () => res.set("Cache-Control", "public, max-age=86400").type(fs.readFileSync(file + ".type", "utf8")).sendFile(file);
  if (fs.existsSync(file) && fs.existsSync(file + ".type")) return send();
  const game = db.prepare("SELECT image, thumbnail FROM games WHERE id = ?").get(id);
  const url = game?.image || game?.thumbnail;
  if (!url || !/^https?:\/\//.test(url)) return res.status(404).end();
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return res.status(404).end();
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  fs.writeFileSync(file + ".type", type);
  send();
}));

function clearCover(id) {
  for (const f of [`${id}.img`, `${id}.img.type`]) fs.rmSync(path.join(COVER_DIR, f), { force: true });
}

// ---------- Collection browser ----------

// Champion of a game = most wins, ties broken by win rate.
function championOf(gameId) {
  return db.prepare(`
    SELECT pl.id, pl.name, pl.color, SUM(pp.winner) AS wins, COUNT(*) AS plays
    FROM play_players pp JOIN plays p ON p.id = pp.play_id JOIN players pl ON pl.id = pp.player_id
    WHERE p.game_id = ?
    GROUP BY pl.id HAVING wins > 0
    ORDER BY wins DESC, CAST(wins AS REAL) / plays DESC, pl.name LIMIT 1`).get(gameId) || null;
}

// Two versions: /api/public/ for everyone (the games and how often they're played, nothing about
// players), and /api/collection for those who may see the stats.
const collectionList = (full) => wrap((req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.year, g.edition, g.bgg_id, g.image, g.thumbnail, g.min_players, g.max_players,
           g.playing_time, g.min_age, g.rating, g.weight, g.categories, g.mechanics, g.types, g.designers, g.created_at,
           COUNT(p.id) AS plays, MAX(p.played_at) AS last_played
    FROM games g LEFT JOIN plays p ON p.game_id = g.id
    WHERE g.parent_id IS NULL
    GROUP BY g.id ORDER BY g.name COLLATE NOCASE`).all();
  const exps = db.prepare(`
    SELECT id, parent_id, name, year, edition FROM games WHERE parent_id IS NOT NULL
    ORDER BY COALESCE(year, 9999), name COLLATE NOCASE`).all();
  for (const g of games) {
    g.expansions = exps.filter((x) => x.parent_id === g.id).map(({ parent_id, ...x }) => x);
    if (full) g.champion = championOf(g.id);
  }
  res.json(games);
});
app.get("/api/collection", collectionList(true));
app.get("/api/public/collection", collectionList(false));

// Everything about one game: details, expansions, and how we've done at it.
const collectionGame = (full) => wrap((req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND parent_id IS NULL").get(req.params.id);
  if (!game) return res.status(404).json({ error: "That game isn't in the collection" });
  game.expansions = db.prepare(`
    SELECT g.id, g.name, g.year, g.edition, g.image, g.thumbnail,
           (SELECT COUNT(*) FROM play_expansions pe WHERE pe.expansion_id = g.id) AS plays
    FROM games g WHERE g.parent_id = ? ORDER BY COALESCE(g.year, 9999), g.name COLLATE NOCASE`).all(game.id);
  const summary = db.prepare(`
    SELECT COUNT(*) AS plays, MIN(played_at) AS first_played, MAX(played_at) AS last_played,
           ROUND(AVG(duration_min)) AS avg_duration, COUNT(duration_min) AS timed_plays,
           MIN(duration_min) AS fastest, MAX(duration_min) AS longest
    FROM plays WHERE game_id = ?`).get(game.id);
  Object.assign(game, {
    avg_duration: summary.avg_duration, timed_plays: summary.timed_plays,
    fastest: summary.fastest, longest: summary.longest,
  });
  game.plays = summary.plays;
  game.first_played = summary.first_played;
  game.last_played = summary.last_played;
  if (!full) return res.json(game);
  game.champion = championOf(game.id);
  game.results = db.prepare(`
    SELECT pl.id, pl.name, pl.color, COUNT(*) AS plays, SUM(pp.winner) AS wins,
           COUNT(*) - SUM(pp.winner) AS losses, MAX(pp.score) AS best_score
    FROM play_players pp JOIN plays p ON p.id = pp.play_id JOIN players pl ON pl.id = pp.player_id
    WHERE p.game_id = ?
    GROUP BY pl.id ORDER BY wins DESC, plays DESC, pl.name`).all(game.id);
  game.recent = playsWithPlayers(db.prepare(`
    SELECT p.* FROM plays p WHERE p.game_id = ? ORDER BY p.played_at DESC, p.id DESC LIMIT 5`).all(game.id));
  res.json(game);
});
app.get("/api/collection/:id", collectionGame(true));
app.get("/api/public/collection/:id", collectionGame(false));

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Boardgame stats listening on http://0.0.0.0:${PORT}`));
