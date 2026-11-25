# Putting the shop online

One shop is one small program with one data folder. Customers open `3d.yourdomain.com`. You open `3d-admin.yourdomain.com` and sign in with a password. Everything you change in the admin is on the customer website a few seconds later.

> Not yet tried on a real server in this package: the program itself, the login, the host rules and the container settings were run and tested on a development machine, but the Docker image and Caddy were not started here. Do the first install yourself with a test domain before you promise a client a date.

## What you need

- A Linux server that stays on: 1 GB RAM works, 2 GB is comfortable (photo shrinking and invoice drawing use some memory). Ubuntu 22.04 or 24.04 is fine. Ports 80 and 443 open.
- A domain and two names that both point to the server's IP (two `A` records): for example `3d.rafid0.com` and `3d-admin.rafid0.com`.
- Use **one-level** names (`3d-admin.rafid0.com`), not `3d.admin.rafid0.com`, so a free Cloudflare certificate covers them if you use Cloudflare.

## A. Server with Docker (recommended)

```bash
# once, on the server
curl -fsSL https://get.docker.com | sh
git clone https://github.com/YOUR-NAME/3d-shop.git shop && cd shop
cp .env.example .env
nano .env            # SITE_HOST, ADMIN_HOST, SITE_URL, ADMIN_PASSWORD
docker compose up -d --build
```

Open `https://3d-admin.yourdomain.com`, sign in, then change the password in **Settings** and remove `ADMIN_PASSWORD` from `.env` (the password is kept hashed in `data/auth.json`; the `.env` value is only used the first time).

The first start can take a minute while Caddy gets its free HTTPS certificates. If it does not, check that both names already point to the server (`dig +short 3d.yourdomain.com`).

### Update to a newer version

```bash
cd shop && git pull && docker compose up -d --build
```

Your `data/` folder is not touched.

### Back up and restore

Everything that matters is the `data/` folder next to `docker-compose.yml`: products, orders, buying costs, settings, the password hash and the photos.

```bash
# a backup (run it from cron every night, and copy the file off the server)
tar czf backup-$(date +%F).tar.gz data
```

Restore or move to another server: install as above, stop it (`docker compose down`), put the `data/` folder back, start again. The admin also has **Settings → Download data backup**, a single file with products, orders and settings (photos are in `data/images`, copy them too).

### Forgot the password

```bash
docker compose exec shop npm run set-password
```

## B. Free, from your own PC (Cloudflare Tunnel)

Costs nothing but the shop is online only while the PC and the program are running. Good for trying things; not for a client's real shop.

1. Cloudflare account with your domain on it. Install `cloudflared`, run `cloudflared tunnel login`, create a tunnel.
2. Add two public hostnames to the tunnel, both with service `http://localhost:3000`: `3d.yourdomain.com` and `3d-admin.yourdomain.com`.
3. Start the program with the same settings as in `.env`:

   ```bash
   npm ci --omit=dev
   ADMIN_HOST=3d-admin.yourdomain.com SITE_HOST=3d.yourdomain.com SITE_URL=https://3d.yourdomain.com \
   TRUST_PROXY=1 COOKIE_SECURE=1 ADMIN_PASSWORD='choose-a-long-password' node server.js
   ```

This route was not tried here.

## C. Server without Docker

```bash
npm ci --omit=dev
```

Run `node server.js` with the environment variables from `.env.example` plus `HOST=0.0.0.0`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`, and keep it running with systemd or pm2. Put any HTTPS reverse proxy in front (Caddy, nginx) that passes the `Host` header through and sends both names to port 3000.

## Settings that matter

| Variable | Meaning |
|---|---|
| `SITE_HOST` | Name customers use. Anything that is not the admin name shows the shop. |
| `ADMIN_HOST` | Name of the admin. Requests for it from any other name are refused. |
| `SITE_URL` | Public address with `https://`, used for link previews and the sitemap. |
| `ADMIN_PASSWORD` | First password, only used if none is stored yet. 8+ characters. |
| `SHOP_TZ` | Time zone for "today" and the Summary. Default `Asia/Dhaka`. |
| `TRUST_PROXY=1` | Set when a proxy (Caddy, Cloudflare) is in front. The container sets it. |
| `COOKIE_SECURE=1` | Login cookie only over HTTPS. The container sets it. |
| `DATA_DIR`, `DIST_DIR` | Where the data and the built website live. The container uses `/data` and `/site`. |

## Safety notes

- Login has a rate limit: 5 free tries, then waits that double up to 15 minutes. The cookie is HttpOnly, SameSite=Strict and Secure on HTTPS.
- The admin only answers on `ADMIN_HOST`. Orders, buying costs, stock counts and customer details are never written into the customer website files; the automated tests scan every published file for them.
- bKash and bank details are shown to customers on purpose. Everything else stays private.
- One shop, one server, one data folder. Do not run two shops from the same data folder.
