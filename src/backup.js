// Daily copies of the database in DATA_DIR/backups, kept for BACKUP_KEEP_DAYS days.
// VACUUM INTO writes a consistent copy while the app keeps running.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { db, DATA_DIR } = require("./db");

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 30);
const NAME_RE = /^boardgames-\d{4}-\d{2}-\d{2}\.db$/;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in the local time zone (TZ)

/** Write a consistent copy of the database to file. */
function copyTo(file) {
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/** Today's backup, if there isn't one yet, then drop the oldest beyond KEEP_DAYS. */
function backupIfDue() {
  const file = path.join(BACKUP_DIR, `boardgames-${today()}.db`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp`;
    copyTo(tmp);
    fs.renameSync(tmp, file);
    console.log(`Backup written: ${path.basename(file)}`);
  }
  const old = list().slice(KEEP_DAYS);
  for (const b of old) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
}

/** Backups on disk, newest first. */
function list() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => NAME_RE.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size }));
}

/** Full path of a backup by name, or null for anything that isn't one. */
function file(name) {
  return NAME_RE.test(name) && fs.existsSync(path.join(BACKUP_DIR, name)) ? path.join(BACKUP_DIR, name) : null;
}

/** A fresh copy in a temp file, for downloading. The caller removes it. */
function snapshot() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "boardgames-")), "boardgames.db");
  copyTo(tmp);
  return tmp;
}

function start() {
  const run = () => {
    try {
      backupIfDue();
    } catch (err) {
      console.error(`Backup failed: ${err.message}`);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { start, list, file, snapshot, BACKUP_DIR, KEEP_DAYS };
