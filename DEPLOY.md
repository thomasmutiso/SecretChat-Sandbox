# SecretChat sandbox — deploy in a few minutes

This folder is the whole sandbox: a small relay server that ALSO serves the SecretChat web app.
Friends open one link in their phone browser, pick an ID, swap IDs, and message. No install, no Play Store.
Messages are end-to-end encrypted and erased once read; the relay only ever sees sealed ciphertext.

Phones over the internet need **https** (so the app can use secure `wss://`). That means a domain name.
Pick ONE option below.

---

## Option A — Your VPS with Docker + Caddy (recommended; gives automatic HTTPS)

You need: the VPS, a domain (or subdomain) pointed at the VPS's IP, and Docker + Caddy installed.

1. Copy this folder to the VPS, e.g. `/opt/secretchat`.
2. Build and run the app:
   ```
   cd /opt/secretchat
   docker build -t secretchat .
   docker run -d --restart unless-stopped -p 8080:8080 --name secretchat secretchat
   ```
3. Point a subdomain at the VPS (an A record, e.g. `chat.yourdomain.com` -> the server IP).
4. Edit `Caddyfile` — replace `chat.example.com` with your subdomain — then run Caddy:
   ```
   caddy run --config Caddyfile
   ```
   (or `sudo caddy start` to keep it running). Caddy fetches the HTTPS certificate on its own.
5. Share `https://chat.yourdomain.com` with your friends. Done.

To keep held messages across a restart: add `-e PERSIST_FILE=/data/held.json -v /opt/secretchat-data:/data` to the `docker run` line.

## Option B — Free host (Render), no server admin

1. Put this folder in a GitHub repo.
2. In Render (dashboard.render.com): **New + > Blueprint**, connect GitHub, choose the repo. Render reads `render.yaml` and sets everything up — just click **Apply**.
3. Render gives you `https://secretchat-sandbox.onrender.com` with `wss` already working. Share that link.
   (Free instances sleep after ~15 min idle and wake on the next visit, so the first open after a pause can take up to a minute. WebSockets work on Render web services, which is what the app needs.)

## Option C — Quick try on the same Wi-Fi (no domain, one device types an address)

For a fast local test before putting it online:
```
npm install
node server.js
```
On the same Wi-Fi, friends open `http://<your-computer-LAN-IP>:8080` (e.g. `http://192.168.1.20:8080`).
This is plain `http`, so it only works on the local network, not over the internet.

---

## Good to know for the sandbox
- Each person claims an ID on their device with a secret token kept in that browser. Same ID + same browser keeps the identity.
- The relay holds a message until the recipient opens and confirms it. Then it's gone from the phone and the relay.
- This is a TEST build. It's encrypted and read-once, but it has not had a security review — don't use it for anything truly sensitive yet.
- The native Android app (deep green / gold, calculator disguise, duress PIN, recovery phrase) is a separate track and still needs a compile-and-sign pass before it can go on phones directly.
