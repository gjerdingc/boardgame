const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { db, tx, DATA_DIR } = require("./db");
const bgg = require("./bgg");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

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

// ---------- Players ----------
app.get("/api/players", wrap((req, res) => {
  res.json(db.prepare("SELECT * FROM players ORDER BY name").all());
}));

app.post("/api/players", wrap((req, res) => {
  const name = String(req.body.name || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : "#f4b860";
  if (!name) throw bad("Name is required");
  if (db.prepare("SELECT 1 FROM players WHERE name = ?").get(name)) throw bad("That player already exists");
  const r = db.prepare("INSERT INTO players (name, color) VALUES (?, ?)").run(name, color);
  res.status(201).json(db.prepare("SELECT * FROM players WHERE id = ?").get(r.lastInsertRowid));
}));

app.put("/api/players/:id", wrap((req, res) => {
  const name = String(req.body.name || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : null;
  if (!name) throw bad("Name is required");
  db.prepare("UPDATE players SET name = ?, color = COALESCE(?, color) WHERE id = ?").run(name, color, req.params.id);
  res.json(db.prepare("SELECT * FROM players WHERE id = ?").get(req.params.id));
}));

app.delete("/api/players/:id", wrap((req, res) => {
  db.prepare("DELETE FROM players WHERE id = ?").run(req.params.id);
  res.status(204).end();
}));

// ---------- Games ----------
const GAME_FIELDS = [
  "name", "bgg_id", "year", "image", "thumbnail", "min_players", "max_players", "playing_time",
  "min_age", "rating", "weight", "categories", "mechanics", "designers", "description",
];

// All games, base games and expansions alike. Expansions have parent_id set;
// their "plays" count is how many plays they were used in.
app.get("/api/games", wrap((req, res) => {
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

app.post("/api/games", wrap((req, res) => {
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
app.put("/api/games/:id", wrap((req, res) => {
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

app.delete("/api/games/:id", wrap((req, res) => {
  const ids = [Number(req.params.id), ...db.prepare("SELECT id FROM games WHERE parent_id = ?").all(req.params.id).map((r) => r.id)];
  db.prepare("DELETE FROM games WHERE id = ?").run(req.params.id); // expansions cascade
  ids.forEach(clearCover);
  res.status(204).end();
}));

// Re-fetch info from BoardGameGeek for a game already in the collection.
app.post("/api/games/:id/refresh", wrap(async (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(req.params.id);
  if (!game?.bgg_id) throw bad("This game is not linked to BoardGameGeek");
  const info = await bgg.thing(game.bgg_id);
  if (!info) throw bad("Not found on BoardGameGeek");
  const fields = GAME_FIELDS.filter((f) => f !== "bgg_id");
  db.prepare(`UPDATE games SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`)
    .run(...fields.map((f) => info[f] ?? null), game.id);
  clearCover(game.id);
  res.json(db.prepare("SELECT * FROM games WHERE id = ?").get(game.id));
}));

// ---------- BoardGameGeek lookup ----------
app.get("/api/bgg/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  res.json(await bgg.search(q));
}));

app.get("/api/bgg/thing/:id", wrap(async (req, res) => {
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

app.get("/api/plays", wrap((req, res) => {
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

app.post("/api/plays", wrap((req, res) => {
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

app.put("/api/plays/:id", wrap((req, res) => {
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

app.delete("/api/plays/:id", wrap((req, res) => {
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

// ---------- Collection browser (read-only, for guests) ----------

// Champion of a game = most wins, ties broken by win rate.
function championOf(gameId) {
  return db.prepare(`
    SELECT pl.id, pl.name, pl.color, SUM(pp.winner) AS wins, COUNT(*) AS plays
    FROM play_players pp JOIN plays p ON p.id = pp.play_id JOIN players pl ON pl.id = pp.player_id
    WHERE p.game_id = ?
    GROUP BY pl.id HAVING wins > 0
    ORDER BY wins DESC, CAST(wins AS REAL) / plays DESC, pl.name LIMIT 1`).get(gameId) || null;
}

app.get("/api/collection", wrap((req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.name, g.year, g.edition, g.bgg_id, g.image, g.thumbnail, g.min_players, g.max_players,
           g.playing_time, g.min_age, g.rating, g.weight, g.categories, g.designers, g.created_at,
           COUNT(p.id) AS plays, MAX(p.played_at) AS last_played
    FROM games g LEFT JOIN plays p ON p.game_id = g.id
    WHERE g.parent_id IS NULL
    GROUP BY g.id ORDER BY g.name COLLATE NOCASE`).all();
  const exps = db.prepare(`
    SELECT id, parent_id, name, year, edition FROM games WHERE parent_id IS NOT NULL
    ORDER BY COALESCE(year, 9999), name COLLATE NOCASE`).all();
  for (const g of games) {
    g.expansions = exps.filter((x) => x.parent_id === g.id).map(({ parent_id, ...x }) => x);
    g.champion = championOf(g.id);
  }
  res.json(games);
}));

// Everything about one game: details, expansions, and how we've done at it.
app.get("/api/collection/:id", wrap((req, res) => {
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
}));

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Boardgame stats listening on http://0.0.0.0:${PORT}`));
