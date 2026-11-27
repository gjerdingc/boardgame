# Game Night — board game stats

A small web app for tracking the board games we play at home.

- **Scoreboard (`/`)**: made for a TV or wall screen. It shows a leaderboard with wins, losses, win rate and recent form, the most played games with cover art and who is best at each, recent plays, plays per month, and a head-to-head table of wins and losses per game and player. It refreshes every minute.
- **Our games (`/games`)**: a read-only page anyone can open, for guests and family to browse the collection. Search by name, designer or theme, filter by player count and playing time, and sort. Tap a game to see its details (players, time, age, complexity, description, expansions) and our record at it. A link like `/games#game-12` opens that game directly, so you can share it. The grid button on the scoreboard leads here.
- **Player pages (`/player?id=…`)**: each player's wins and losses per game, head to head, and every game they've played.
- **Manage (`/admin`)**, for everyone at home, guests too: log plays (game, date, who played, winners, optional scores, how long it took and notes), add games, and add players. The **+** button in the bottom-right corner of the scoreboard leads here.
- **Expansions**: add expansions under each game on the Games tab, either picked from BoardGameGeek's list for that game or typed by name. When you log a play, tick which expansions you used. An expansion found through the main BGG search is filed under its base game automatically, if that game is already in the collection.
- **BoardGameGeek lookup**: search BGG when you add a game. The app saves the name, year, cover image, player count, playing time, rating, weight, categories, mechanics, designers and description to the local database. Cover images are cached locally (only JPEG, PNG, WebP, GIF and AVIF pictures from public addresses, up to 10 MB).

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
DEV_USER_EMAIL=you@example.com BGG_TOKEN=your-token npm start
```

Then open <http://localhost:8080>. Data is stored in `./data` (change it with `DATA_DIR`).
Without the gateway nobody is signed in; `DEV_USER_EMAIL` pretends you are, which managing needs (or set `ADMIN_SIGN_IN=optional`). It is ignored
when `NODE_ENV=production`, as in the container.

## Who sees what

The app runs behind the [homelab gateway](https://github.com/gjerdingc/traefik-lab-lb) (Traefik with
Google sign-in), on one name. The gateway decides who reaches which path. To change anything you
must be at home **and** signed in with an allowed Google account: the gateway checks both, and the
app checks the sign-in again (`ADMIN_SIGN_IN`, below).

| Who | Collection (`/games`) | Scoreboard, players, stats | Manage (`/admin`) |
|---|---|---|---|
| Anyone on the internet | Yes | Sent to `/games` until they sign in | No |
| Signed in with an allowed Google account | Yes | Yes | Only at home |
| At home, not signed in | Yes | Yes | No: asked to sign in |

How the paths are laid out:

- `/games`, `/assets/`, `/covers/`, `/api/public/` and the icons `/favicon.svg` and `/apple-touch-icon.png`: open to everyone, read-only. `/api/public/` has the games and how often they're played, nothing about players.
- `/admin` and `/api/admin/`: everything that changes data (and the BoardGameGeek lookups). The gateway keeps them to home, and the app answers 401 to anyone not signed in. The change log records who did what.
- `/api/admin/` never answers a page from another site (it checks `Sec-Fetch-Site` and `Origin`), so another website can't make a visitor's browser change or download anything.
- Paths are case-sensitive, as in the gateway's rules: `/API/ADMIN/...` is a 404, not a way around them.
- Everything else: read-only stats. Any other method than GET and HEAD gets 405 from the app, whatever the gateway lets through.
- `/oauth2/`: sign in and out, served by the gateway.

The app reads who is signed in from `X-Auth-Request-Email`, which the gateway sets and removes from what clients send. **Never publish the container's port**: reached around the gateway, anyone could change the data or claim to be someone else.

### Gateway setup

Needs Google sign-in set up in the gateway (`COMPOSE_PROFILES=sso`, `SSO_DOMAIN`, see its guide), with the app's name under `SSO_DOMAIN`, and a Let's Encrypt certificate so guests' phones trust it.

1. **IP lists**: add one named `home` with your home network (IPv4 and, if you use it, IPv6 prefix).
2. **Settings → Google sign-in**: the accounts that may see the stats from outside.
3. **Add app**: the app's name, backend `http://boardgame-stats:8080`, Let's Encrypt, **LAN only** off, **Require Google sign-in** off, and these **Path rules**:

```
/admin                          from=home  sign-in
/api/admin/                     from=home  sign-in=401
/admin /api/admin/              deny
/games /assets/ /covers/ /api/public/ /favicon.svg /apple-touch-icon.png  open  read-only
/                               from=home  optional  read-only
/api/                           sign-in=401  read-only
/                               sign-in=/games  read-only
```

Top to bottom: manage from home only, signed in, and from nowhere else. The collection is open. At home everything else is readable without signing in. Elsewhere the API answers 401 and pages go to `/games` until you sign in. The **+** button on the scoreboard only shows where `/api/admin/` answers, so not from outside.

`from=home` uses the client's own address. Reach the gateway from home directly (split DNS to the gateway's local address), not through a port forward that rewrites the source.
**Check this before you open the app to the internet**: visit it from a phone on mobile data and look at the gateway's **Traffic** page. The address shown must be the phone's public one, not your router's or a `172.x` Docker address. If every visitor looks like they are at home (source NAT or hairpin NAT on the port forward, Cloudflare Tunnel, Docker hiding IPv6 clients behind its bridge), `from=home` matches everyone.

To let everyone at home manage without signing in again (guests logging their own games), set
`ADMIN_SIGN_IN=optional` and use `optional` instead of `sign-in` / `sign-in=401` in the first two
rules. Then the only thing between the internet and the admin pages is the client's address.

Nothing here names a domain: changing it means the gateway's `ALLOWED_DOMAINS`, `SSO_DOMAIN` and the app's name, DNS, the redirect URI of the Google OAuth client, and a new QR code (`public/assets/games-qr.*`).

## Backups

Every day the app writes a copy of the database to `/data/backups/boardgames-YYYY-MM-DD.db` and keeps the last `BACKUP_KEEP_DAYS` (default 30). Anyone at home can download any of them, or a fresh one, under **Manage → History**, which also lists who changed what.

Copies on the same disk don't survive losing the disk: also copy `/opt/boardgame/backups` somewhere else, for instance from a NAS that pulls it. To restore, stop the stack, delete `boardgames.db-wal` and `boardgames.db-shm` in `/opt/boardgame`, replace `boardgames.db` with a backup, and start it again.

## Deployment

GitHub Actions builds the image on every push to `main` (not for README-only changes) and
pushes it to `ghcr.io/gjerdingc/boardgame` as `:latest` and `:sha-<short commit>`, for amd64
and arm64. It first starts the container and checks that it answers; if that fails, nothing is pushed. Pull requests are built and checked, not pushed.

Portainer stack from this repository, compose path `docker-compose.yml`. The host only pulls
the image, so it needs internet access to `ghcr.io`, but no build tools. Stack environment variables:

| Variable | What it does |
|---|---|
| `BGG_TOKEN` | BoardGameGeek API token, see above |
| `BACKUP_KEEP_DAYS` | Daily backups to keep, default 30 |
| `ADMIN_SIGN_IN` | `required` (default): changing anything needs a signed-in user. `optional`: anyone who reaches `/admin` may (see Gateway setup) |

The container `boardgame-stats` has no host port. It joins the external Docker network
`proxy` and serves plain HTTP on port 8080; the gateway terminates HTTPS. It runs as the
`node` user (the entrypoint makes `/data` writable for it first).

Data is kept on the host in `/opt/boardgame` (mounted at `/data`): `boardgames.db` with its
`-wal` and `-shm` files, `backups/` and the cover image cache `covers/`. Docker creates the
folder on the first deploy.

To update, push to `main`, wait for the **image** workflow under the repository's **Actions** tab to
go green (a minute or two), then use **Pull and redeploy** on the stack. Or let Portainer do it:
under the stack's **GitOps updates**, turn on automatic updates (polling, for example every 5
minutes) with **Re-pull image** and **Force redeployment** on. Portainer then pulls `:latest` at
every check and only replaces the container when the image has changed.

To roll back, change the image in `docker-compose.yml` to an earlier `:sha-<short commit>` tag
(they are listed under the repository's **Packages**), or set it in the stack's editor.

To build the image on your own machine: `docker build -t boardgame .`
