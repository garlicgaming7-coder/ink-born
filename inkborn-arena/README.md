# Inkborn Arena

Draw a creature, raise it, and auto-battle other players' fighters online.

- `public/index.html`: the whole game (one file).
- `server.js`: serves the game and runs the online arena. It has no dependencies.
- `data/arena.json`: created automatically. It holds every fighter and fight result.

## Run it on your computer

1. Install Node.js 18 or newer from https://nodejs.org (the "LTS" button).
2. Open a terminal in this folder and run:
   ```
   node server.js
   ```
3. Open http://localhost:3000.

To test with two players, open a second browser or a private window, draw a different fighter, and challenge the first one.

## Put it on the internet

The server must keep running and must keep `data/arena.json` between restarts. Static hosts like Netlify or GitHub Pages can't run it. Pick a host that runs Node and gives you a persistent disk:

**Railway** (https://railway.app)
1. Put this folder in a GitHub repository.
2. Create a new project, then choose Deploy from GitHub repo. It finds `package.json` and runs `npm start`.
3. Add a Volume mounted at `/data`, and add the variable `DATA_DIR=/data`.
4. Under Settings → Networking, generate a domain. That's your game's link.

**Render** (https://render.com)
1. Create a new Web Service from the repository, with start command `node server.js`.
2. Add a Disk mounted at `/data` and set `DATA_DIR=/data`. Disks need a paid instance. On the free plan the server sleeps and the arena is wiped whenever it restarts.

**Any Linux server (VPS)**
1. Install Node 18 or newer, copy the folder over, and run `PORT=80 node server.js`.
2. Keep it running with `pm2` or a systemd service. Put it behind Caddy or nginx if you want HTTPS.

Settings, all optional: `PORT` (default 3000) and `DATA_DIR` (default `./data`).

## How online play works

- Each browser gets a player id and a secret key, stored in that browser. Clearing site data loses access to that fighter's online entry.
- Players enter their fighter (drawing plus stats) in the online arena. Anyone can challenge anyone. The other player doesn't need to be online.
- **The server runs every online fight**, using the stats stored on the server, so nobody can fake a result.
- Raising still happens in each player's browser, so a determined cheater could edit their stats. The server limits how fast stats can grow (about 40 power per hour) to blunt that.
- Updates reach everyone live through `/api/events`.

## Resetting the arena

Stop the server, delete `data/arena.json`, and start it again.
