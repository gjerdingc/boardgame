# Game Night — board game stats

A small web app for tracking the board games we play at home.

- **Scoreboard (`/`)**: made for a TV or wall screen. It shows a leaderboard with wins, losses, win rate and recent form, the most played games with cover art and who is best at each, recent plays, plays per month, and a head-to-head table of wins and losses per game and player. It refreshes every minute.
- **Our games (`/games`)**: a read-only page for guests and family to browse the collection. Search by name, designer or theme, filter by player count and playing time, and sort. Tap a game to see its details (players, time, age, complexity, description, expansions) and our record at it. A link like `/games#game-12` opens that game directly, so you can share it. The grid button on the scoreboard leads here.
- **Manage (`/admin`)**: log plays (game, date, who played, winners, optional scores, how long it took and notes), add games, and add players. The **+** button in the bottom-right corner of the scoreboard leads here.
- **Expansions**: add expansions under each game on the Games tab, either picked from BoardGameGeek's list for that game or typed by name. When you log a play, tick which expansions you used. An expansion found through the main BGG search is filed under its base game automatically, if that game is already in the collection.
- **BoardGameGeek lookup**: search BGG when you add a game. The app saves the name, year, cover image, player count, playing time, rating, weight, categories, mechanics, designers and description to the local database. Cover images are cached locally.

Everything lives in one SQLite file (`/data/boardgames.db` in the container).

## BoardGameGeek token

BGG's XML API now requires a registered application token. Register at
<https://boardgamegeek.com/applications>, then set the token as `BGG_TOKEN`. Without a
token BGG search fails, but you can still add games manually on the Games tab.

## Running locally

Needs Node.js 22.5 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
BGG_TOKEN=your-token npm start
```

Then open <http://localhost:8080>. Data is stored in `./data` (change it with `DATA_DIR`).

## Deployment

Portainer stack from this repository, compose path `docker-compose.yml`.
Set this stack environment variable: `BGG_TOKEN` (BoardGameGeek API token, see above).

The container `boardgame-stats` has no host port. It joins the external Docker network
`proxy` and serves plain HTTP on port 8080. Point Traefik at
`http://boardgame-stats:8080`; Traefik terminates HTTPS.

Data is kept in the named volume `boardgame-data`, mounted at `/data`. Back up that volume to keep your history.

To update, use **Pull and redeploy** on the stack.

> The manage page has no login. Anyone who can reach the site can add or delete data,
> so keep it on your home network or behind Traefik auth if it is exposed.
