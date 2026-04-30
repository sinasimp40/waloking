# OTA Update Server

A small Express server that hosts launcher + server updates for all your customers. Runs on port **4231**.

## Quick start (on your RDP / Windows server)

1. Copy this `update-server/` folder to your RDP machine.
2. Double-click `start.bat` (run as Administrator the first time so it can add the firewall rule).
3. The server starts on `http://0.0.0.0:4231`.
4. Customers' installed launchers will start polling within 2 minutes.

## Quick start (Linux / macOS)

```bash
cd update-server
npm install
node server.js
```

Make sure port 4231 is open in your firewall:
```bash
sudo ufw allow 4231/tcp     # Ubuntu/Debian
sudo firewall-cmd --add-port=4231/tcp --permanent && sudo firewall-cmd --reload   # CentOS/RHEL
```

## Verifying which build is running

The admin panel header shows a `BUILD` field with a short content hash (e.g.
`7ca8680 · 2026-04-30 14:02 · node v24.10.0`). It's a sha256 of the running
update-server's source files, truncated to 7 hex chars — same idea as a git
short rev, but it works without git installed.

Use this when troubleshooting "is my fix actually deployed?" After copying a
new `update-server/` folder to your Windows machine and restarting `start.bat`,
the `BUILD` hash should change. If it doesn't, you're still running the old
code. The same data is also available at `GET /api/admin/version` (admin auth
required; `GET /api/admin/build-info` is an equivalent alias) and inside
`/api/admin/status`.

## How publishing works

After you've built one or more customers (`build-all.bat`), run:

```bash
node scripts/publish-update.js --all      # publish all customers
node scripts/publish-update.js cafe-a     # publish one customer
publish-update.bat cafe-a                 # Windows convenience wrapper
```

This:
1. Bumps the manifest at `update-server/public/updates/<channel>/latest.json`
2. Copies the new payload zip into `update-server/public/updates/<channel>/<version>/`
3. Within 2 minutes, every installed launcher on that channel detects the new version, downloads, and prompts to restart.

## File layout

```
update-server/
  server.js              ← Express app
  package.json
  start.bat              ← starts server + adds firewall rule
  stop-firewall-rule.bat ← removes firewall rule
  public/
    updates/
      <channel>/
        latest.json
        <version>/
          launcher-payload.zip
      <channel>-server/
        latest.json
        <version>/
          server-payload.zip
```

## Endpoints

| URL | Purpose |
|---|---|
| `GET /` | Web dashboard listing all channels |
| `GET /health` | Health check JSON |
| `GET /updates/<channel>/latest.json` | Latest version manifest |
| `GET /updates/<channel>/<version>/launcher-payload.zip` | Update payload |

## Firewall command (manual)

If you prefer to run it yourself:

```cmd
netsh advfirewall firewall add rule name="NEXTREME-OTA-4231" dir=in action=allow protocol=TCP localport=4231
```

To remove:
```cmd
netsh advfirewall firewall delete rule name="NEXTREME-OTA-4231"
```

## Security notes

- Updates are integrity-checked via SHA-256 hash matching on the client side
- Consider putting this behind HTTPS (Caddy / nginx reverse proxy) for production
- Firewall rule allows inbound on port 4231 only — no other ports exposed
