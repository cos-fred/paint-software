# Deploying VEEMENZ Online

This guide gets VEEMENZ live on the internet with a shared SQLite database on a
persistent disk, so everyone sees the same data with live (WebSocket) updates.

The app needs two things from the host:

1. **A persistent disk** — so the `paint_inventory.db` file survives redeploys.
2. **A `JWT_SECRET` environment variable** — a long random string.

The code is already prepared:
- `server.js` reads `process.env.PORT` (cloud hosts set this).
- `database.js` reads `process.env.DB_PATH` and auto-creates its folder.
- `services/realtime.js` + `services/audit.js` broadcast changes over WebSockets.
- `.env.example` lists every setting.

---

## Option 1 — Railway (easiest)

1. **Push this folder to GitHub.**
   ```bash
   git init
   git add .
   git commit -m "VEEMENZ"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/paint-software.git
   git push -u origin main
   ```

2. **Create the app on Railway**
   - Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select your repo.
   - Railway auto-detects Node and runs `npm start`.

3. **Add a persistent volume (for the database)**
   - In your service → **Settings → Volumes** → **Add Volume**.
   - Mount path: `/data`
   - (This keeps the SQLite file across deploys.)

4. **Set environment variables** (service → **Variables**)
   | Name | Value |
   |------|-------|
   | `JWT_SECRET` | a long random string (see `.env.example`) |
   | `DB_PATH` | `/data/paint_inventory.db` |
   | `BACKUP_DIR` | `/data/backups` |
   | `CORS_ORIGIN` | `https://your-app.up.railway.app` (or `*`) |

5. Railway gives you a **public URL** (e.g. `https://your-app.up.railway.app`).
   Open it → login with `admin` / `admin123` (then change the password).

> Note: `better-sqlite3` ships prebuilt binaries, so it usually installs cleanly.
> A `Dockerfile`, `.nvmrc` and `nixpacks.toml` are already included to pin Node 20
> and provide native build tools. If Nixpacks fails on the native module, switch
> your Railway builder to **Dockerfile** (it will use the included Dockerfile).

---

## Option 2 — Render (free tier, with caveats)

1. Push to GitHub (same as above).
2. [render.com](https://render.com) → **New → Web Service** → connect repo.
3. Build command: `npm install` · Start command: `npm start`.
4. **Persistent disk**: Render free disks are not persistent unless you add a
   **paid disk** (New → Disk, mount at `/data`). Without a disk, the database
   resets on each deploy — not recommended for production.
5. Env vars: same as the Railway table above.
6. Render gives you a URL like `https://your-app.onrender.com`.

> Render free instances **sleep after ~15 min of inactivity** and take ~30s to
> wake. For a real business, use Railway (or a paid Render plan / VPS).

---

## Option 3 — Your own VPS (full control)

```bash
# on the server
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential python3
git clone https://github.com/YOUR_USERNAME/paint-software.git
cd paint-software
npm install
cp .env.example .env   # then edit JWT_SECRET and DB_PATH
nohup npm start &
```

Point a domain at it and put it behind HTTPS (Caddy/Nginx + Let's Encrypt).

---

## Security checklist (before going live)

- [ ] Set a strong random `JWT_SECRET`.
- [ ] Change the default admin password (Profile → Change Password).
- [ ] Set `CORS_ORIGIN` to your domain (not `*`).
- [ ] Enable HTTPS (Railway/Render do this automatically).

## What "real-time" means here

Any time someone saves a sale, product, customer, transfer, return, or stock
change, the server broadcasts a `data-changed` event over WebSockets. Every open
browser tab automatically refreshes its current screen and dashboard — so two
people in different locations always see the same, current data without manually
reloading.
