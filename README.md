# Game Night — board game stats

A small web app for tracking the board games we play at home.

- **Scoreboard (`/`)**: made for a TV or wall screen. It shows a leaderboard with wins, losses, win rate and recent form, the most played games with cover art and who is best at each, recent plays, plays per month, and a head-to-head table of wins and losses per game and player. It refreshes every minute.
- **Our games (`/games`)**: a read-only page anyone can open, for guests and family to browse the collection. Search by name, designer or theme, filter by player count and playing time, and sort. Tap a game to see its details (players, time, age, complexity, description, expansions) and our record at it. A link like `/games#game-12` opens that game directly, so you can share it. The grid button on the scoreboard leads here.
- **Player pages (`/player?id=…`)**: each player's wins and losses per game, head to head, and every game they've played.
- **Manage (`/admin`)**, for admins: log plays (game, date, who played, winners, optional scores, how long it took and notes), add games, and add players. The **+** button in the bottom-right corner of the scoreboard leads here.
- **Expansions**: add expansions under each game on the Games tab, either picked from BoardGameGeek's list for that game or typed by name. When you log a play, tick which expansions you used. An expansion found through the main BGG search is filed under its base game automatically, if that game is already in the collection.
- **BoardGameGeek lookup**: search BGG when you add a game. The app saves the name, year, cover image, player count, playing time, rating, weight, categories, mechanics, designers and description to the local database. Cover images are cached locally.

Everything lives in one SQLite file (`/data/boardgames.db` in the container).

## BoardGameGeek token

BGG's XML API now requires a registered application token. Register at
<https://boardgamegeek.com/applications>, then set the token as `BGG_TOKEN`. Without a
token BGG search fails, but you can still add games manually on the Games tab.

### Linking games you added by hand

If games were added by hand (for example before you had a token), the Games tab
shows **Link your games to BoardGameGeek**. It searches BGG for each game using its
name and year, and you review the matches before anything changes. Linking fills in
player count, playing time, age, complexity, type, category, mechanism, designers
and description. Your own names, years, editions and image links are kept.
Requests are spaced out (about one a second) to be polite to BGG.

## Running locally

Needs Node.js 22.5 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
ADMIN_EMAILS=you@example.com DEV_USER_EMAIL=you@example.com BGG_TOKEN=your-token npm start
```

Then open <http://localhost:8080>. Data is stored in `./data` (change it with `DATA_DIR`).
Without the gateway nobody is signed in, so `DEV_USER_EMAIL` pretends you are. It is ignored
when `NODE_ENV=production`, as in the container.

## Who sees what

The app runs behind the [homelab gateway](https://github.com/gjerdingc/traefik-lab-lb) (Traefik with
Google sign-in), on one name. The gateway decides who reaches which path; the app only checks who is
an admin.

| Who | Collection (`/games`) | Scoreboard, players, stats | Manage (`/admin`) |
|---|---|---|---|
| Anyone on the internet | Yes | Sent to `/games` until they sign in | No |
| Signed in with an allowed Google account | Yes | Yes | No |
| At home, not signed in | Yes | Yes | Sign in first |
| At home, signed in, in `ADMIN_EMAILS` | Yes | Yes | Yes |

How the paths are laid out:

- `/games`, `/assets/`, `/covers/` and `/api/public/`: open to everyone, read-only. `/api/public/` has the games and how often they're played, nothing about players.
- `/admin` and `/api/admin/`: everything that changes data (and the BoardGameGeek lookups). The app answers 403 unless the signed-in user is in `ADMIN_EMAILS`. Without `ADMIN_EMAILS`, nobody can change anything.
- Everything else: read-only stats. Any other method than GET and HEAD gets 405 from the app, whatever the gateway lets through.
- `/oauth2/`: sign in and out, served by the gateway.

The app reads who is signed in from `X-Auth-Request-Email`, which the gateway sets and removes from what clients send. **Never publish the container's port**: reached around the gateway, anyone could claim to be an admin.

### Gateway setup

Needs Google sign-in set up in the gateway (`COMPOSE_PROFILES=sso`, `SSO_DOMAIN`, see its guide), with the app's name under `SSO_DOMAIN`, and a Let's Encrypt certificate so guests' phones trust it.

1. **IP lists**: add one named `home` with your home network (IPv4 and, if you use it, IPv6 prefix).
2. **Settings → Google sign-in**: the accounts that may see the stats. Admins must be on it too.
3. **Add app**: the app's name, backend `http://boardgame-stats:8080`, Let's Encrypt, **LAN only** off, **Require Google sign-in** off, and these **Path rules**:

```
/admin /api/admin/              from=home  sign-in
/admin /api/admin/              deny
/games /assets/ /covers/ /api/public/  open  read-only
/                               from=home  optional  read-only
/api/                           sign-in=401  read-only
/                               sign-in=/games  read-only
```

Top to bottom: manage only from home and after signing in, and from nowhere else. The collection is open. At home everything else is readable without signing in (a signed-in admin still gets the + button). Elsewhere the API answers 401 and pages go to `/games` until you sign in.

4. In the boardgame stack, set `ADMIN_EMAILS`.

`from=home` uses the client's own address. Reach the gateway from home directly (split DNS to the gateway's local address), not through a port forward that rewrites the source.

Nothing here names a domain: changing it means the gateway's `ALLOWED_DOMAINS`, `SSO_DOMAIN` and the app's name, DNS, the redirect URI of the Google OAuth client, and a new QR code (`public/assets/games-qr.*`).

## Backups

Every day the app writes a copy of the database to `/data/backups/boardgames-YYYY-MM-DD.db` and keeps the last `BACKUP_KEEP_DAYS` (default 30). Admins can download any of them, or a fresh one, under **Manage → History**, which also lists who changed what.

Copies on the same disk don't survive losing the disk: also copy `/opt/boardgame/backups` somewhere else, for instance from a NAS that pulls it. To restore, stop the stack, delete `boardgames.db-wal` and `boardgames.db-shm` in `/opt/boardgame`, replace `boardgames.db` with a backup, and start it again.

## Deployment

Portainer stack from this repository, compose path `docker-compose.yml`. Stack environment variables:

| Variable | What it does |
|---|---|
| `ADMIN_EMAILS` | Google accounts that may add and change things, comma-separated |
| `BGG_TOKEN` | BoardGameGeek API token, see above |
| `BACKUP_KEEP_DAYS` | Daily backups to keep, default 30 |

The container `boardgame-stats` has no host port. It joins the external Docker network
`proxy` and serves plain HTTP on port 8080; the gateway terminates HTTPS. It runs as the
`node` user (the entrypoint makes `/data` writable for it first).

Data is kept on the host in `/opt/boardgame` (mounted at `/data`): `boardgames.db` with its
`-wal` and `-shm` files, `backups/` and the cover image cache `covers/`. Docker creates the
folder on the first deploy.

To update, use **Pull and redeploy** on the stack.
