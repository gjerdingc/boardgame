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

app.get("/api/games", wrap((req, res) => {
  res.json(db.prepare(`
    SELECT g.*, COUNT(p.id) AS plays FROM games g
    LEFT JOIN plays p ON p.game_id = g.id
    GROUP BY g.id ORDER BY g.name`).all());
}));

app.post("/api/games", wrap((req, res) => {
  const g = {};
  for (const f of GAME_FIELDS) g[f] = req.body[f] === "" || req.body[f] === undefined ? null : req.body[f];
  g.name = String(g.name || "").trim();
  if (!g.name) throw bad("Game name is required");
  if (g.bgg_id && db.prepare("SELECT 1 FROM games WHERE bgg_id = ?").get(g.bgg_id)) {
    throw bad("That game is already in the collection");
  }
  const r = db.prepare(
    `INSERT INTO games (${GAME_FIELDS.join(",")}) VALUES (${GAME_FIELDS.map(() => "?").join(",")})`
  ).run(...GAME_FIELDS.map((f) => g[f]));
  res.status(201).json(db.prepare("SELECT * FROM games WHERE id = ?").get(r.lastInsertRowid));
}));

app.delete("/api/games/:id", wrap((req, res) => {
  db.prepare("DELETE FROM games WHERE id = ?").run(req.params.id);
  clearCover(Number(req.params.id));
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
  return rows.map((r) => ({ ...r, players: pp.all(r.id).map((p) => ({ ...p, winner: !!p.winner })) }));
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
  if (!db.prepare("SELECT 1 FROM games WHERE id = ?").get(game_id)) throw bad("Pick a game");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(played_at || "")) throw bad("Pick a date");
  if (players.length === 0) throw bad("Add at least one player");
  return { game_id, played_at, notes: notes ? String(notes) : null, players };
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
    const r = db.prepare("INSERT INTO plays (game_id, played_at, notes) VALUES (?, ?, ?)")
      .run(play.game_id, play.played_at, play.notes);
    savePlayPlayers(r.lastInsertRowid, play.players);
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
    db.prepare("UPDATE plays SET game_id = ?, played_at = ?, notes = ? WHERE id = ?")
      .run(play.game_id, play.played_at, play.notes, id);
    savePlayPlayers(id, play.players);
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
           (SELECT COUNT(*) FROM games) AS games,
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
    SELECT g.id, g.name, g.year, g.image, g.thumbnail, g.min_players, g.max_players, g.playing_time, g.rating,
           COUNT(p.id) AS plays, MAX(p.played_at) AS last_played
    FROM games g LEFT JOIN plays p ON p.game_id = g.id
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

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Boardgame stats listening on http://0.0.0.0:${PORT}`));
