# RDP Migration Checklist — May 2026

Step-by-step guide for moving your existing OTA update server installation on the Windows RDP machine to the new folder layout (`update-server/` is now at the **repo root**, not inside `walok/`) **without losing any customer data**.

> **Total downtime: ~5 minutes.** Customers' launchers will simply retry their next 2-minute poll once the server is back up — they won't see errors.

> **Critical: nothing here touches your installed customer launchers.** This is a server-side move only. Customers don't need to reinstall, restart, or do anything.

---

## What you're moving

The OTA update server folder used to live inside the project folder:

```
OLD (before May 2026):
C:\walok-project\walok\
   ├── src\, server\, electron\, scripts\, branding\, customers\, ...
   └── update-server\          ← OTA server lived HERE
       ├── server.js
       ├── data\               ← launcher.db (admin password hash, build history, etc.)
       └── public\updates\     ← published .zip payloads served to customers
```

After this migration the OTA server is its own top-level folder, sibling to `walok/`:

```
NEW (May 2026):
C:\walok-project\
   ├── walok\                   ← project source
   │   ├── src\, server\, electron\, scripts\, branding\, customers\, ...
   │   └── (no more update-server\ here)
   └── update-server\           ← OTA server now lives HERE
       ├── server.js
       ├── data\                ← launcher.db (preserved)
       └── public\updates\      ← payloads (preserved)
```

The two folders that **must** be siblings in the same parent: `walok/` and `update-server/`. The OTA server auto-finds `walok/` via its `findProjectRoot()` helper.

---

## What to back up FIRST (the only data that matters)

Two folders inside your existing `walok\update-server\` contain irreplaceable state:

1. **`walok\update-server\data\`** — the SQLite database folder. Always copy the **entire `data\` folder**, not just one file — SQLite uses WAL (write-ahead log) mode so the on-disk state is split across:
   - `launcher.db` — main database (admin password hash, customer list, last-built timestamps, build job history, source-baseline metadata)
   - `launcher.db-wal` — pending writes not yet checkpointed back to the main file
   - `launcher.db-shm` — shared memory index for the WAL
   
   If you copy only `launcher.db` and skip the `-wal` file, you can lose recent writes (e.g. a customer added in the last few minutes). Copy the whole folder.

2. **`walok\update-server\public\updates\`** — every published payload your customers' launchers are downloading from. **If you delete this folder, every running customer launcher will get 404s on its next poll** until you re-publish.

There's also a third "nice to have":

3. **`walok\customers\`** — your customer JSON configs. These travel with the `walok/` folder so as long as you don't blow away `walok/` you're fine, but a fresh backup zip never hurts.

---

## The migration steps (do these in order)

### Step 1 — Open RDP and stop the running OTA server

1. Switch to the CMD window that's running `start.bat` (the one showing `Update server listening on http://0.0.0.0:4231`).
2. Press **Ctrl+C** in that window. Confirm if Windows prompts. The window should return to a `>` prompt.
3. Confirm the server is stopped: open a browser to `http://localhost:4231/health` — you should get a connection refused / page-not-loaded error. **Good — server is off.**

### Step 2 — Make the safety backup

In Windows Explorer, navigate to your project folder (e.g. `C:\walok-project\`). 

Right-click on the **`walok\update-server\`** folder → **Send to → Compressed (zipped) folder**. Rename the resulting zip to something like `OTA-BACKUP-2026-05-01.zip` and **move it to a safe location** (Desktop, OneDrive, USB stick — anywhere NOT inside `walok\`).

This single zip contains your `data\launcher.db` + every published payload. If anything goes wrong you can fully restore the old setup by extracting it back into place and rerunning the old `start.bat`.

### Step 3 — Sync the new code from the Replit project

Get the new layout onto the RDP. Easiest way: **download the entire updated project as a zip from Replit** (top-right menu → Export / Download), upload it to the RDP via Remote Desktop file copy, and extract it somewhere temporary (e.g. `C:\walok-project-NEW\`).

After extraction, the temp folder should have BOTH `walok\` and `update-server\` as siblings. Confirm this before continuing:

```
C:\walok-project-NEW\
   ├── walok\              ← exists, no update-server\ inside it
   ├── update-server\      ← exists at top level
   ├── scripts\
   └── replit.md
```

If `update-server\` is missing or is still inside `walok\`, you've downloaded an old copy — re-export from Replit.

### Step 4 — Move your data into the new layout

This is the critical step. You're moving the database + published payloads from your backup into the NEW `update-server\` folder so customers don't lose anything.

1. Open `C:\walok-project-NEW\update-server\`.
2. If there's an existing `data\` folder there, **delete it** (the new code ships with an empty placeholder; we want the one from your backup).
3. Copy the **entire `data\` folder** from your backup zip → into `C:\walok-project-NEW\update-server\data\`. After the copy you should see THREE files inside: `launcher.db`, `launcher.db-wal`, `launcher.db-shm` (the `-wal` and `-shm` files may be missing if the old server was cleanly stopped — that's fine, but always copy them if they exist).
4. Confirm there's an empty `public\updates\` folder in the new location. If not, create one.
5. Copy the **entire contents** of `public\updates\` from your backup zip → into `C:\walok-project-NEW\update-server\public\updates\`. You should end up with one subfolder per customer channel (e.g. `cafe-a\`, `cafe-a-server\`, `cafe-b\`, etc.), each containing version subfolders with `*.zip` payloads.

Spot-check: open `C:\walok-project-NEW\update-server\public\updates\<one-channel>\latest.json` in Notepad. You should see a JSON file with a `version` field. If yes, you copied correctly.

### Step 5 — Swap the folders

Now swap your old project folder with the new one, in place.

1. Rename `C:\walok-project\` → `C:\walok-project-OLD\` (so we keep it around as one more safety net).
2. Rename `C:\walok-project-NEW\` → `C:\walok-project\`.
3. Delete the old, empty `walok\update-server\` subdir inside `C:\walok-project-OLD\walok\` if it's still there (it's now redundant — the real one moved up a level).

### Step 6 — Restart the server

1. Open `C:\walok-project\update-server\` in Windows Explorer.
2. Right-click **`start.bat`** → **Run as Administrator** (admin only needed for the firewall rule on first run; subsequent runs don't need it but it's harmless).
3. Wait for the banner:
   ```
   Listening on:    http://0.0.0.0:4231
   Project root:    C:\walok-project\walok
   Customers in DB: <N>
   ```
4. Verify "Project root" line says `C:\walok-project\walok` (or whatever your real path is — the key is it ends with `\walok`). **If it says `null` or "project root not found", STOP — see Troubleshooting below.**
5. Verify "Customers in DB" matches what you had before — this confirms `launcher.db` was carried over correctly.
6. Open `http://localhost:4231/admin/` in a browser, log in with your existing password (which came over with `launcher.db`).
7. The admin panel header should show the customer count + per-channel cards as before. Open one channel — the version + last-published timestamp should match what was published before the move. **Good — full migration successful.**

### Step 7 — Confirm customers are unaffected

From the RDP browser, hit your published manifest URL directly:

```
http://localhost:4231/updates/<one-channel>/latest.json
```

You should see the JSON manifest with the same version + URL + sha256 as before. This is exactly what every running customer launcher will fetch on its next poll. **If you see this JSON, customers are 100% unaffected by the move.**

Within 2 minutes, every running launcher does its routine poll, gets the same `latest.json` it expected, sees no version bump, and goes back to sleep. **Zero customer-visible disruption.**

---

## Rollback plan (if anything goes wrong)

You have **two safety nets** so rollback is fast:

**Quickest rollback (~2 minutes):**

1. Stop the new `start.bat` with Ctrl+C.
2. Rename `C:\walok-project\` → `C:\walok-project-FAILED\`.
3. Rename `C:\walok-project-OLD\` → `C:\walok-project\`.
4. Run `C:\walok-project\walok\update-server\start.bat` (the OLD location, since you're back on the old layout).
5. Server is back up exactly as it was before you started, no data loss.

**If you also need to restore `data\` / payloads** (e.g. you accidentally deleted them in step 4):

1. Stop any running server.
2. Extract `OTA-BACKUP-2026-05-01.zip` somewhere.
3. Copy the entire `data\` folder and `public\updates\` from the backup back into the OLD location's `walok\update-server\`.
4. Restart `start.bat` from the OLD location.

---

## Troubleshooting

**"Project root: null" in the boot banner**
- The OTA server can't find a sibling `walok\` folder. Confirm `update-server\` and `walok\` are both directly inside `C:\walok-project\` (not nested differently).
- The auto-detection looks for `..\walok\` first, then `..` (the legacy in-walok layout) as a fallback.

**Admin login says "wrong password" after migration**
- Your `data\` folder didn't get copied correctly. Stop the server, copy the **entire `data\` folder** (including `launcher.db`, `launcher.db-wal`, and `launcher.db-shm` if present) from your backup zip into `update-server\data\`, restart.

**Customer launcher says "no updates" but you just published one**
- Open `http://localhost:4231/updates/<channel>/latest.json` from the RDP. If you get a 404, the `public\updates\` payload didn't migrate. Restore it from the backup zip and copy into `update-server\public\updates\`.
- If the JSON loads with the right version, it's a network/firewall issue on the customer's end — not a migration issue.

**Firewall window pops up asking to allow node.exe**
- Click **Allow access**. Should only happen once.

**Both old AND new servers tried to start (port conflict)**
- Make sure the old `start.bat` window is fully closed (Ctrl+C twice, then close the window).
- `netstat -ano | findstr :4231` shows you what process owns the port.

---

## After successful migration

Once you've confirmed everything works (admin panel loads, customer manifests serve correctly, a test build succeeds), you can:

1. **Delete `C:\walok-project-OLD\`** — frees up disk space. Keep the backup zip on a USB / OneDrive for at least a week.
2. **Try the new "Update Project Source" flow:** zip the entire `walok\` folder (excluding `node_modules\`, `releases\`, `dist\`, `customers\`), upload it via the admin panel's blue card, then click "Build All Customers." See `walok\UPDATING.md` for full instructions.
3. **Keep the backup zip** for at least one full update cycle — once you've shipped one update with the new flow and customers are happily updated, you can delete the backup.

---

## Quick reference — what got moved

| Item | OLD location | NEW location | Migrated by |
|---|---|---|---|
| OTA server code | `walok\update-server\server.js` | `update-server\server.js` | Step 3 (re-download) |
| Database (whole `data\` folder) | `walok\update-server\data\` (`launcher.db` + `-wal` + `-shm`) | `update-server\data\` | Step 4 (manual copy of folder) |
| Published payloads | `walok\update-server\public\updates\` | `update-server\public\updates\` | Step 4 (manual copy) |
| Launcher source | `walok\src\`, `walok\electron\`, etc. | `walok\src\`, `walok\electron\`, etc. | Step 3 (unchanged path) |
| Customer configs | `walok\customers\` | `walok\customers\` | Step 3 (unchanged path) |
| Customer logos | `walok\branding\` | `walok\branding\` | Step 3 (unchanged path) |
| Build outputs | `walok\releases\` | `walok\releases\` | Step 3 (unchanged path) |

All paths inside `walok\` are unchanged — only `update-server\` moved up one level.
