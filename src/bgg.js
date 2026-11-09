// BoardGameGeek XML API2 client.
// BGG requires a registered application token for API access:
// https://boardgamegeek.com/applications  -> set BGG_TOKEN in the environment.
const { XMLParser } = require("fast-xml-parser");

// BGG_BASE_URL is only for pointing tests at a stand-in server.
const BASE = process.env.BGG_BASE_URL || "https://boardgamegeek.com/xmlapi2";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["item", "name", "link", "rank"].includes(name),
});

// BGG's game "types" (subdomains) show up as family rankings, e.g. name="strategygames".
const TYPE_NAMES = {
  strategygames: "Strategy",
  familygames: "Family",
  partygames: "Party",
  thematic: "Thematic",
  wargames: "War game",
  abstracts: "Abstract",
  childrensgames: "Children's",
  cgs: "Customizable",
};

// Space requests out so a bulk job (linking a whole collection) stays polite to BGG.
const MIN_GAP_MS = Number(process.env.BGG_MIN_GAP_MS) || 1200;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => {
  const n = Number(v && typeof v === "object" ? v.value : v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#10;/g, "\n")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&amp;/g, "&");
}

async function fetchXml(pathAndQuery) {
  const headers = { "User-Agent": "home-boardgame-stats/1.0" };
  if (process.env.BGG_TOKEN) headers.Authorization = `Bearer ${process.env.BGG_TOKEN}`;

  // BGG sometimes answers 202 ("queued, try again") — retry a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    const res = await fetch(BASE + pathAndQuery, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 202 || res.status === 429 || res.status === 503) {
      // 202 = queued, 429/503 = slow down. Back off and push later requests back too.
      const delay = (res.status === 202 ? 2000 : 5000) * (attempt + 1);
      nextSlot = Math.max(nextSlot, Date.now() + delay);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("BoardGameGeek refused the request. Set a valid BGG_TOKEN (see README).");
    }
    if (!res.ok) throw new Error(`BoardGameGeek returned HTTP ${res.status}`);
    return parser.parse(await res.text());
  }
  throw new Error("BoardGameGeek is busy, try again in a moment.");
}

function parseSearch(xml) {
  return asArray(xml?.items?.item).map((it) => {
    const names = asArray(it.name);
    const primary = names.find((n) => n.type === "primary") || names[0] || {};
    return {
      bgg_id: Number(it.id),
      name: decodeEntities(primary.value),
      year: num(it.yearpublished),
      is_expansion: it.type === "boardgameexpansion",
    };
  });
}

function parseThing(xml) {
  return parseThings(xml)[0] || null;
}

function parseThings(xml) {
  return asArray(xml?.items?.item).map(parseThingItem);
}

function parseThingItem(it) {
  const names = asArray(it.name);
  const primary = names.find((n) => n.type === "primary") || names[0] || {};
  const links = asArray(it.link);
  const linkValues = (type) =>
    links.filter((l) => l.type === type).map((l) => decodeEntities(l.value)).slice(0, 12).join(", ") || null;
  const ratings = it.statistics?.ratings || {};
  const types = [
    ...asArray(ratings.ranks?.rank).filter((r) => r.type === "family").map((r) => TYPE_NAMES[r.name] ||
      String(r.friendlyname || r.name || "").replace(/\s*(Game)?\s*Rank$/i, "").trim()),
    ...links.filter((l) => l.type === "boardgamesubdomain").map((l) => decodeEntities(l.value).replace(/\s*Games?$/i, "")),
  ].filter(Boolean);
  const rating = num(ratings.average);
  const weight = num(ratings.averageweight);
  // On a base game, "boardgameexpansion" links list its expansions.
  // On an expansion, the same links are marked inbound="true" and point to its base game(s).
  const expansionLinks = links.filter((l) => l.type === "boardgameexpansion");
  const toRef = (l) => ({ bgg_id: Number(l.id), name: decodeEntities(l.value) });
  const isExpansion = it.type === "boardgameexpansion";
  return {
    bgg_id: Number(it.id),
    name: decodeEntities(primary.value),
    is_expansion: isExpansion,
    base_games: isExpansion ? expansionLinks.filter((l) => String(l.inbound) === "true").map(toRef) : [],
    expansions: isExpansion ? [] : expansionLinks.filter((l) => String(l.inbound) !== "true").map(toRef),
    year: num(it.yearpublished),
    image: it.image ? String(it.image).trim() : null,
    thumbnail: it.thumbnail ? String(it.thumbnail).trim() : null,
    min_players: num(it.minplayers),
    max_players: num(it.maxplayers),
    playing_time: num(it.playingtime),
    min_age: num(it.minage),
    rating: rating ? Math.round(rating * 100) / 100 : null,
    weight: weight ? Math.round(weight * 100) / 100 : null,
    categories: linkValues("boardgamecategory"),
    mechanics: linkValues("boardgamemechanic"),
    types: [...new Set(types)].join(", ") || null,
    designers: linkValues("boardgamedesigner"),
    description: decodeEntities(it.description).trim() || null,
  };
}

async function search(query, { exact = false, type = "boardgame,boardgameexpansion" } = {}) {
  const xml = await fetchXml(
    `/search?type=${type}${exact ? "&exact=1" : ""}&query=${encodeURIComponent(query)}`
  );
  return parseSearch(xml).slice(0, 30);
}

async function thing(id) {
  const xml = await fetchXml(`/thing?stats=1&id=${encodeURIComponent(id)}`);
  return parseThing(xml);
}

// Details for many games at once (BGG allows up to 20 ids per request).
async function things(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const xml = await fetchXml(`/thing?stats=1&id=${ids.slice(i, i + 20).join(",")}`);
    out.push(...parseThings(xml));
  }
  return out;
}

module.exports = { search, thing, things, parseSearch, parseThing, parseThings, parser };
