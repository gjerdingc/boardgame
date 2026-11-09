const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "boardgames.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color      TEXT NOT NULL DEFAULT '#f4b860',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    bgg_id       INTEGER UNIQUE,
    year         INTEGER,
    image        TEXT,
    thumbnail    TEXT,
    min_players  INTEGER,
    max_players  INTEGER,
    playing_time INTEGER,
    min_age      INTEGER,
    rating       REAL,
    weight       REAL,
    categories   TEXT,
    mechanics    TEXT,
    designers    TEXT,
    description  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    played_at  TEXT NOT NULL,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS play_players (
    play_id   INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    winner    INTEGER NOT NULL DEFAULT 0,
    score     REAL,
    PRIMARY KEY (play_id, player_id)
  );

  CREATE INDEX IF NOT EXISTS idx_plays_game ON plays(game_id);
  CREATE INDEX IF NOT EXISTS idx_pp_player ON play_players(player_id);
`);

// --- Migrations for databases created by earlier versions ---

const gameColumns = db.prepare("PRAGMA table_info(games)").all().map((c) => c.name);

// Which edition the copy we own is. Free text: "2", "3", "Revised", "Deluxe"…
if (!gameColumns.includes("edition")) {
  db.exec("ALTER TABLE games ADD COLUMN edition TEXT");
}

// BGG's game types, e.g. "Strategy, Family".
if (!gameColumns.includes("types")) {
  db.exec("ALTER TABLE games ADD COLUMN types TEXT");
}

// Expansions are games that belong to a base game (parent_id).
if (!gameColumns.includes("parent_id")) {
  db.exec("ALTER TABLE games ADD COLUMN parent_id INTEGER REFERENCES games(id) ON DELETE CASCADE");
}

// How long a play took, in minutes (optional).
const playColumns = db.prepare("PRAGMA table_info(plays)").all().map((c) => c.name);
if (!playColumns.includes("duration_min")) {
  db.exec("ALTER TABLE plays ADD COLUMN duration_min INTEGER");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_games_parent ON games(parent_id);

  -- Which expansions were used in a play.
  CREATE TABLE IF NOT EXISTS play_expansions (
    play_id      INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
    expansion_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    PRIMARY KEY (play_id, expansion_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pe_expansion ON play_expansions(expansion_id);
`);

/** Run fn inside a transaction. */
function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { db, tx, DATA_DIR };
