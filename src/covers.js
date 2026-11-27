// Cover images, fetched from the game's image link and cached in DATA_DIR/covers.
//
// /covers/<id> is open to everyone and the links are typed in by people, so a fetch:
//   - only goes to public addresses (never this host, the Docker network or the LAN), checked
//     on the address actually connected to, and again after every redirect;
//   - only keeps pictures (JPEG, PNG, WebP, GIF, AVIF). Never SVG, which can carry scripts;
//   - stops at MAX_BYTES, and a link that failed is not tried again for FAIL_TTL_MS.
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { DATA_DIR } = require("./db");

const COVER_DIR = path.join(DATA_DIR, "covers");
fs.mkdirSync(COVER_DIR, { recursive: true });

const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;
const FAIL_TTL_MS = 10 * 60 * 1000;

// Everything that isn't the public internet. Two lists, because a BlockList also checks IPv4
// addresses against IPv4-mapped IPv6 rules, and ::ffff:0:0/96 would then block every IPv4 address.
const PRIVATE_V4 = new net.BlockList();
const PRIVATE_V6 = new net.BlockList();
for (const [a, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) PRIVATE_V4.addSubnet(a, bits, "ipv4");
for (const [a, bits] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) PRIVATE_V6.addSubnet(a, bits, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !PRIVATE_V4.check(address, "ipv4");
  if (family !== 6) return false;
  // ::ffff:10.0.0.1 and the like are IPv4 addresses in disguise.
  const mapped = address.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPublicAddress(mapped[1]);
  return !PRIVATE_V6.check(address, "ipv6");
}

const refuse = (msg) => Object.assign(new Error(msg), { code: "ECOVER" });

// dns.lookup that only hands back public addresses, used for the connection itself, so a name
// can't resolve to a public address when checked and a private one when connected.
function publicLookup(isAllowed) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || addresses.some((a) => !isAllowed(a.address))) {
        return callback(refuse(`${hostname} is not a public address`));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * Fetch a picture: { type, body }. Rejects for anything else.
 * isAllowed decides which addresses may be connected to (tests use a stand-in server on localhost).
 */
function fetchImage(link, { isAllowed = isPublicAddress, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(link);
    } catch {
      return reject(refuse("Not a web address"));
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return reject(refuse("Only http and https"));
    if (url.username || url.password) return reject(refuse("No passwords in links"));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // An address in the link itself is never looked up, so it is checked here.
    if (net.isIP(host) && !isAllowed(host)) return reject(refuse(`${host} is not a public address`));

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "home-boardgame-stats/1.0", Accept: [...TYPES].join(", ") },
      lookup: publicLookup(isAllowed),
    }, (res) => {
      const done = (err, value) => {
        clearTimeout(timer);
        res.destroy();
        return err ? reject(err) : resolve(value);
      };
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) return done(refuse("Too many redirects"));
        let next;
        try {
          next = new URL(res.headers.location, url).href;
        } catch {
          return done(refuse("Bad redirect"));
        }
        clearTimeout(timer);
        res.destroy();
        return fetchImage(next, { isAllowed, redirects: redirects + 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) return done(refuse(`HTTP ${res.statusCode}`));
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!TYPES.has(type)) return done(refuse(`Not a picture (${type || "no type"})`));
      if (Number(res.headers["content-length"]) > MAX_BYTES) return done(refuse("Picture too large"));
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) return done(refuse("Picture too large"));
        chunks.push(c);
      });
      res.on("end", () => done(null, { type, body: Buffer.concat(chunks) }));
      res.on("error", done);
    });
    const timer = setTimeout(() => req.destroy(refuse("Timed out")), TIMEOUT_MS);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const files = (id) => {
  const file = path.join(COVER_DIR, `${id}.img`);
  return { file, typeFile: `${file}.type` };
};

const failed = new Map(); // id -> time a failed fetch may be tried again
const pending = new Map(); // id -> promise of the fetch under way

/** The cached cover of a game: { file, type }, fetching it first if needed, or null. */
async function get(id, linkOf) {
  const { file, typeFile } = files(id);
  if (fs.existsSync(file) && fs.existsSync(typeFile)) {
    const type = fs.readFileSync(typeFile, "utf8").trim();
    if (TYPES.has(type)) return { file, type };
    clear(id); // cached by an older version (for instance an SVG): fetch it again
  }
  if ((failed.get(id) || 0) > Date.now()) return null;
  if (!pending.has(id)) {
    pending.set(id, (async () => {
      const link = linkOf();
      if (!link) return null;
      try {
        const { type, body } = await fetchImage(link);
        fs.writeFileSync(`${file}.tmp`, body);
        fs.renameSync(`${file}.tmp`, file);
        fs.writeFileSync(typeFile, type);
        return { file, type };
      } catch (err) {
        failed.set(id, Date.now() + FAIL_TTL_MS);
        console.log(`Cover for game #${id} not fetched: ${err.message}`);
        return null;
      }
    })().finally(() => pending.delete(id)));
  }
  return pending.get(id);
}

/** Forget a game's cover, for instance when its image link changes. */
function clear(id) {
  failed.delete(Number(id));
  const { file, typeFile } = files(id);
  for (const f of [file, typeFile]) fs.rmSync(f, { force: true });
}

module.exports = { get, clear, fetchImage, isPublicAddress, TYPES, MAX_BYTES };
