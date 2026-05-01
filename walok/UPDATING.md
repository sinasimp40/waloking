# How to Push an Update to Your Customers

This is the complete step-by-step for shipping a new version of the launcher (or server) to every installed customer over the air.

You can manage everything from the **web admin panel** at `http://<YOUR-RDP-IP>:4231/admin/` once setup is done — uploading customer logos, editing configs, bumping the version, and triggering builds with a live build log all happen in the browser. The CLI scripts below still work if you prefer them.

---

## RECOMMENDED FLOW (May 2026 onwards): one zip, one upload

The simplest way to ship an update — works for code changes anywhere in the project (`src/`, `server/`, `electron/`, `scripts/`, `package.json`, etc.):

1. **Make your code changes** locally to the `walok/` folder.
2. **Zip the entire `walok/` folder** so the zip contains `src/`, `server/`, `electron/`, `scripts/`, `public/`, `package.json`, etc. **at the top level**. (You can exclude `node_modules/`, `releases/`, `dist/`, `customers/`, and `.build-jobs/` — they'll be preserved on the server.)
3. Open the admin panel → **Update Source Files** → click the blue **"Update Project Source"** card → pick your zip → **Replace Project Source**. Wait ~10–60s.
4. Click **Build All Customers**. The server rebuilds + publishes for every customer in `customers/`. Within 2 minutes every running launcher detects the update and prompts to restart.

That's it. One zip updates BOTH the launcher AND the server (and `electron/`, and the scripts). Operator-managed state — your customer JSON configs in `customers/`, per-customer logos `branding/<channel>-logo.png`, build outputs in `releases/`, and `node_modules/` — is preserved.

> **Why not the per-piece "Launcher Source" / "Server Source" cards?** Those are now in the **Advanced** dropdown. Use them only when you want to ship a launcher-only or server-only change without touching the other half. Most of the time, the unified "Update Project Source" card is what you want.

---

## ONE-TIME SETUP (do these once)

### A. Set up the update server on your RDP

1. Copy the entire project to your RDP machine. The two folders that matter are `update-server/` (the OTA server itself, lives at the **repo root** as of May 2026 — it used to be `walok/update-server/`) and `walok/` (the launcher source the OTA server builds from). Both folders should be siblings in the same parent directory (e.g. `C:\walok-project\update-server\` and `C:\walok-project\walok\`).
2. Open the `update-server/` folder, **right-click `start.bat` → Run as Administrator** (the first time only — it needs admin rights to add the firewall rule).
3. You should see:
   ```
   [start] Adding firewall rule for port 4231...
   [start] Update server listening on http://0.0.0.0:4231
   ```
4. Leave that window open. The server is now reachable from any PC at `http://<YOUR-RDP-IP>:4231`.
5. Test it from your own PC: open `http://<YOUR-RDP-IP>:4231/health` in a browser. You should see a JSON response.

### A2. Open the web admin panel

1. Browse to `http://<YOUR-RDP-IP>:4231/admin/` (or `http://localhost:4231/admin/` from the RDP itself).
2. **Login password:**
   - The server requires the `OTA_ADMIN_PASSWORD` environment variable to be set. Set it before launching `start.bat` — open a CMD window in `update-server/` and run:
     ```bat
     set OTA_ADMIN_PASSWORD=admin
     node server.js
     ```
     (Replace `admin` with whatever password you want. Use at least 8 characters in production.)
   - If `OTA_ADMIN_PASSWORD` is missing the server refuses to boot and prints a clear error — there is no auto-generated password file.
   - To change it, set a new value for `OTA_ADMIN_PASSWORD` and restart `start.bat`.
3. After 5 wrong password attempts the panel locks that IP for 5 minutes — wait it out.
4. Once logged in you can: add/edit/delete customers, upload per-customer logos, bump the version, and trigger BUILD / BUILD&PUBLISH / PUBLISH for one customer or all customers, watching the live console output as it happens.

> **If you ever need to remove the firewall rule later**, run `stop-firewall-rule.bat` (also as admin).

### B. Add each customer's config

For every cafe / customer, create one JSON file in `customers/`. Example: `customers/cafe-a.json`

```json
{
  "channel": "cafe-a",
  "brandName": "CAFE A GAMING",
  "subtitle": "Your Premium Lounge",
  "logo": "branding/cafe-a-logo.png",
  "updateServer": "http://203.0.113.45:4231"
}
```

- `channel` — unique short ID (letters/numbers/dashes only). This is baked into their installed launcher.
- `updateServer` — the URL of YOUR RDP server from step A above. **Use your real public IP**, not `localhost`.
- `logo` — drop the customer's logo PNG into `branding/` and reference it here.

Then build their first version:
```cmd
build-customer.bat cafe-a
```
Output goes to `releases/cafe-a/1.0.0/`. Send the `*.zip` inside that folder to the customer. They extract it anywhere and double-click `Launcher.exe` — done. No installer.

> Build all customers at once with `build-all.bat`.

---

## THE UPDATE LOOP (do this every time you ship a new version)

### Step 1 — Bump the version

Edit `package.json` and change:
```json
"version": "1.0.0"
```
to whatever's next, e.g. `"1.0.1"`.

(If you're updating the companion server, edit `server/package.json` the same way.)

### Step 2 — Build the new version for every customer

```cmd
build-all.bat
```

Or just one customer:
```cmd
build-customer.bat cafe-a
```

This creates fresh portable folders + zips in `releases/<channel>/<version>/`.

### Step 3 — Publish to the update server

```cmd
publish-update.bat --all
```

Or just one:
```cmd
publish-update.bat cafe-a
```

This:
1. Copies the new zip into `update-server/public/updates/<channel>/<version>/`
2. Writes a fresh `latest.json` manifest with the new version number + SHA-256 hash

**Then copy the updated `update-server/public/updates/` folder to your RDP** (overwriting the old one), so the running update server can serve it. The Express server picks up new files immediately — no restart needed.

> **Tip:** You can also work directly on the RDP — clone the project there and run all three steps in place. Then you skip the copy.

---

## What customers see

Within **2 minutes** of you publishing, every running launcher on that channel will:
1. Detect the new version
2. Pop up the cyberpunk update modal with a live progress bar
3. Download the payload (a few MB), verify SHA-256
4. Show a 5-second restart countdown
5. Restart automatically — the new version is live

If their launcher is closed, the update is detected and applied the next time they open it.

**Customer settings, accounts, save data, and admin config are all preserved** — only the program files are updated.

---

## Updating the companion server (separately)

The save/load server has its own update channel: `<channel>-server`.

1. Bump `server/package.json` version
2. `build-customer.bat cafe-a` (rebuilds both launcher AND server for that customer)
3. `publish-update.bat cafe-a` (publishes both)

The server polls and updates independently. Customers don't need to do anything — their tray-icon server will restart silently within 2 minutes.

---

## Troubleshooting

**Customer says "no updates showing up":**
- Confirm your update server is actually reachable from THEIR network. From their PC, open `http://<YOUR-RDP-IP>:4231/health` in a browser.
- Confirm port 4231 is open on the RDP firewall (`start.bat` does this automatically as admin).
- Confirm the version in `update-server/public/updates/<channel>/latest.json` is HIGHER than the version baked into their installed launcher.

**Update downloaded but didn't apply:**
- Check for `.ota-pending/FAILED` inside their launcher folder. If present, it has the failure reason.
- The system refuses to mark a partial update as applied — they keep running the old version safely. Just publish a fresh build and they'll retry.

**Want to roll back:**
- Delete the bad version folder under `update-server/public/updates/<channel>/`
- Re-publish the previous version (or hand-edit `latest.json` to point at the older one)
- Customers stay on the bad version until you ship a NEW version higher than it (downgrade isn't automatic by design, for safety)

---

## Quick reference

| What | Command |
|---|---|
| Start update server | `start.bat` (in `update-server/`, as Admin first time) |
| Stop firewall rule | `stop-firewall-rule.bat` |
| Build one customer | `build-customer.bat <channel>` |
| Build all customers | `build-all.bat` |
| Publish one customer | `publish-update.bat <channel>` |
| Publish all customers | `publish-update.bat --all` |
| Server URL | `http://<YOUR-RDP-IP>:4231` |
| Manifest URL | `http://<YOUR-RDP-IP>:4231/updates/<channel>/latest.json` |
| Health check | `http://<YOUR-RDP-IP>:4231/health` |
| Dashboard | `http://<YOUR-RDP-IP>:4231/` |
