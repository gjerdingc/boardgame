// Matching games that were added by hand to their BoardGameGeek entries.
// Pure functions, so they can be tested without talking to BGG.

/** Lowercase, straighten quotes and dashes, drop punctuation and extra spaces. */
function normalize(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rank BGG search results for one of our games.
 * `baseName` is set for expansions, so "European Expansion" also matches
 * BGG's "Wingspan: European Expansion".
 *
 * Returns { candidates, best, confidence }:
 *  - "sure":  exactly one candidate with the same name (and the same year, if we know it)
 *  - "guess": a likely candidate, but the user should check it
 *  - "none":  nothing usable
 */
function rankCandidates(game, results, { baseName = null, takenIds = new Set() } = {}) {
  const want = normalize(game.name);
  const wantWithBase = baseName ? normalize(`${baseName}: ${game.name}`) : null;

  const scored = [];
  const seen = new Set();
  for (const r of results) {
    if (!r.bgg_id || seen.has(r.bgg_id) || takenIds.has(r.bgg_id)) continue;
    seen.add(r.bgg_id);
    const n = normalize(r.name);
    let nameScore = 0;
    if (n === want || (wantWithBase && n === wantWithBase)) nameScore = 3;
    else if (baseName && n.endsWith(` ${want}`) && n.startsWith(normalize(baseName))) nameScore = 2;
    else if (n.includes(want) || want.includes(n)) nameScore = 1;
    const yearScore = game.year && r.year ? (r.year === game.year ? 2 : Math.abs(r.year - game.year) <= 1 ? 1 : -1) : 0;
    scored.push({ ...r, nameScore, yearScore, exactName: nameScore === 3 });
  }

  scored.sort((a, b) => b.nameScore + b.yearScore - (a.nameScore + a.yearScore) || (a.year || 9999) - (b.year || 9999));
  const candidates = scored.slice(0, 10).map(({ nameScore, yearScore, ...c }) => c);

  const exact = scored.filter((c) => c.nameScore === 3);
  const exactSameYear = exact.filter((c) => c.yearScore === 2);
  let best = null;
  let confidence = "none";
  if (exactSameYear.length === 1) {
    best = exactSameYear[0].bgg_id;
    confidence = "sure";
  } else if (exact.length === 1 && !game.year) {
    best = exact[0].bgg_id;
    confidence = "sure";
  } else if (scored.length && scored[0].nameScore >= 1) {
    best = scored[0].bgg_id;
    confidence = "guess";
  }
  return { candidates, best, confidence };
}

module.exports = { normalize, rankCandidates };
