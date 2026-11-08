// BoardGameGeek XML API2 client.
// BGG requires a registered application token for API access:
// https://boardgamegeek.com/applications  -> set BGG_TOKEN in the environment.
const { XMLParser } = require("fast-xml-parser");

const BASE = "https://boardgamegeek.com/xmlapi2";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["item", "name", "link"].includes(name),
});

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
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + pathAndQuery, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 202 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
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
    return { bgg_id: Number(it.id), name: decodeEntities(primary.value), year: num(it.yearpublished) };
  });
}

function parseThing(xml) {
  const it = asArray(xml?.items?.item)[0];
  if (!it) return null;
  const names = asArray(it.name);
  const primary = names.find((n) => n.type === "primary") || names[0] || {};
  const links = asArray(it.link);
  const linkValues = (type) =>
    links.filter((l) => l.type === type).map((l) => decodeEntities(l.value)).slice(0, 8).join(", ") || null;
  const ratings = it.statistics?.ratings || {};
  const rating = num(ratings.average);
  const weight = num(ratings.averageweight);
  return {
    bgg_id: Number(it.id),
    name: decodeEntities(primary.value),
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
    designers: linkValues("boardgamedesigner"),
    description: decodeEntities(it.description).trim() || null,
  };
}

async function search(query) {
  const xml = await fetchXml(`/search?type=boardgame,boardgameexpansion&query=${encodeURIComponent(query)}`);
  return parseSearch(xml).slice(0, 30);
}

async function thing(id) {
  const xml = await fetchXml(`/thing?stats=1&id=${encodeURIComponent(id)}`);
  return parseThing(xml);
}

module.exports = { search, thing, parseSearch, parseThing, parser };
