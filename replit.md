# WALOK — Multi-Customer Game Launcher with OTA Update System

## Overview

WALOK is a system for building and distributing per-customer branded game launchers (Electron + React + Vite) to internet cafes and gaming lounges. Each customer gets their own branded build (custom name, logo, app ID) that checks for over-the-air (OTA) updates from a self-hosted Express update server. The system supports unlimited customers managed from a single web admin panel.

**Core components:**
1. **Launcher** (`walok/` root) — Electron + React app, built per-customer via rebranding scripts
2. **Companion Server** (`walok/server/`) — Electron app serving a local REST API (saves, user auth) for each cafe
3. **OTA Update Server** (`walok/update-server/`) — Express server on port 4231, hosts builds and admin panel, runs on operator's Windows RDP

**Key workflows:**
- Operator adds customer JSON config → runs build → update server packages and publishes the branded build
- Installed launchers poll update server every 2 minutes AND maintain a live SSE connection for instant push notifications
- When a new version is published, launchers auto-download, verify SHA-256, stage to `.ota-pending/`, then apply on next restart

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Launcher (Frontend + Electron Shell)
- **Stack:** React 18, Vite 5, TailwindCSS 3, Framer Motion, Zustand for state
- **Fonts:** Orbitron + Rajdhani for cyberpunk aesthetic
- **Electron shell:** `electron/main.js` hosts the window; `electron/preload.js` exposes a safe `electronAPI` bridge to the renderer via contextBridge
- **No installer wizard:** Built as portable ZIP (`asar: false` for launcher, `asar: true` for server). Customer extracts and runs directly — no admin rights needed
- **Integrity protection:** `scripts/integrity-beforepack.js` injects a random secret into the asar before pack; `scripts/integrity-postpack.js` records HMAC of exe+secret into `resources/integrity.dat`; `electron/integrity-check.js` verifies at startup and exits if tampered

### Per-Customer Branding System
- Each customer = one JSON file in `customers/<channel>.json` with `channel`, `brandName`, `subtitle`, `logo`, `updateServer`
- `scripts/rebrand.js` does a full find-and-replace across all source files (JS, HTML, JSON) to rename the brand, app ID, storage keys, and legacy migration arrays
- `scripts/build-customer.js` orchestrates: sync logo → rebrand → write `ota-config.json` → `vite build` → `electron-builder` → collect artifacts → publish
- `branding/config.json` tracks current brand state; `branding/<channel>-logo.<ext>` is the per-customer logo source (hard failure if missing — prevents cross-customer logo leakage)
- Legacy prefixes are accumulated in migration arrays so old installs rename their data folders on upgrade

### OTA Update Flow
1. Launcher reads baked-in `ota-config.json` (channel, updateServer URL, version)
2. **SSE live push** (`electron/ota-live.js`): Long-lived GET to `/api/live/:channel/:role/:instance` — server pushes `{type:'update'}` instantly when admin publishes
3. **HTTP poll fallback** (`electron/updater.js`): every 2 min fetches `/updates/<channel>/latest.json`
4. If newer version: download ZIP payload, verify SHA-256, stage to `.ota-pending/`, show progress modal
5. On restart: extract staged ZIP over install folder BEFORE React loads, delete staging dir, continue
6. **Rebrand handling:** When exe name changes (e.g. `BLAST.exe` → `BLASTING.exe`), manifest includes `exeName`; updater spawns new exe and writes `.ota-cleanup.json` marker; next launch sweeps and deletes the old exe (and any Desktop/Start menu shortcuts pointing to it)

### OTA Update Server (`update-server/`)
- **Framework:** Express 4 on port 4231
- **Database:** `better-sqlite3` (WAL mode) at `update-server/data/launcher.db`
  - `customers` table: channel, brand_name, subtitle, update_server, logo, launcher_version, server_version, timestamps
  - `meta` table: key-value store
- **Auth:** Cookie-based session with bcrypt password stored in `.admin-password` file; 5-attempt lockout per IP for 5 minutes
- **Admin panel:** Static HTML at `update-server/public/admin/` served by Express
- **Build job system** (`update-server/job-runner.js`):
  - Max 2 concurrent builds (`OTA_MAX_BUILDS`, default 2)
  - Each job runs in isolated workspace (`.build-jobs/<jobId>/`) with node_modules junctioned (not copied) for speed
  - Jobs for the same channel are serialized (conflict avoidance)
  - Real cancel: `taskkill /T /F` on Windows, SIGKILL process group on POSIX
  - SSE-style live log streaming to admin browser
  - Queue: jobs exceeding concurrency wait until a slot opens
- **Live registry** (`update-server/live.js`): Tracks all connected launcher/server instances per channel — shows online/offline + running version in admin panel; 25s heartbeat, 90s stale eviction
- **Cleanup** (`update-server/cleanup.js`): After each build, removes old version directories under `releases/<channel>/` and `public/updates/<channel>/` keeping only the newest
- **Install lock** (`update-server/install-lock.js`): Cross-process filesystem lock at `<projectRoot>/.ota-install.lock` guarding the npm-install pre-flight in `/api/admin/build`. Atomic via `fs.openSync(..., 'wx')`, mtime-based stale recovery (30 min default), token-checked `release()` so a slow holder cannot delete a successor's lock, `touch()` heartbeat called between install steps, 2-minute acquire timeout. Prevents two OTA server instances against the same project root from corrupting shared `node_modules`. The handler double-checks `rootDepsInstalled()` after acquiring.
- **Publish output dir contract** (`scripts/publish-update.js`): build jobs run inside an ephemeral workspace clone at `<projectRoot>/.build-jobs/<jobId>/`, so the script's `__dirname`-derived default (`ROOT/update-server/public/updates`) lands in the workspace and gets wiped seconds later by `finishJob`. The OTA server passes `OTA_UPDATES_DIR=UPDATES_DIR` (the real updates dir on the host) to the publish step; the script honors that env var when set and falls back to the workspace-relative path otherwise (preserves direct CLI usage from the real project root). Without this, every BUILD/BUILD ALL would record a version in the DB but leave no manifest or zip on disk — making the customer card show "[file missing — rebuild]" + "Last release: ---" despite a successful build. Regression-tested by `update-server/test-publish-paths.js`.

### Companion Server (`server/`)
- **Framework:** Express 4 with CORS, Multer for file uploads
- **Database:** `sql.js` (SQLite in-memory, persisted to file) — tables: `users`, `saves`
- **Auth:** bcryptjs passwords + JWT tokens (7-day expiry), `EXAMPLE_CAFE_JWT_SECRET` env var (rebrand script normalizes the env var name per customer)
- **Features:** User registration/login, save file upload/download, per-user folder isolation
- **Electron shell:** System tray icon, BrowserWindow showing dashboard HTML, OTA updater wired same as launcher

### Build Scripts
- `scripts/rebrand.js` — full source tree rebranding (strings, app IDs, storage keys, JWT env var names, ICO generation via pure-JS ICO builder using `sharp` for PNG resizing)
- `scripts/build-customer.js` — single customer build pipeline with retry logic for Windows EPERM on dist directories
- `scripts/build-all.js` — iterates all `customers/*.json` sequentially (server-side job runner handles parallelism for admin-triggered builds)
- `scripts/publish-update.js` — creates `latest.json` manifest with SHA-256 and `exeName` field, copies ZIP to `update-server/public/updates/<channel>/`
- `scripts/collect-builds.js` — gathers final artifacts, verifies integrity manifests
- `scripts/verify-signatures.js` — optional Authenticode signature verification via `signtool`

### IGDB Integration
- `vite-igdb-plugin.js` — Vite dev server plugin that proxies IGDB API requests (avoids CORS), caches OAuth tokens, forwards game search/image requests to `api.igdb.com`

### Testing
- `tests/test-rebrand-update.js` — pure JS regression test for OTA apply + cleanup marker sweep (no Electron needed)
- `tests/test-server-rebrand.js` — same for server.exe including shortcut sweep
- `tests/test-build-all-logo-isolation.js` — regression test for per-customer logo isolation
- `update-server/test-job-runner.js` — smoke tests for job runner concurrency, cancel, queue, SSE replay
- `update-server/test-install-lock.js` — cross-process filesystem-lock tests for the npm-install pre-flight (atomicity, idempotent release, timeout, stale reclaim, finally-release crash safety, real two-process race)
- `update-server/test-publish-paths.js` — script-level test that `scripts/publish-update.js` honors `OTA_UPDATES_DIR` (real publish dir vs ephemeral workspace clone) and falls back to the workspace-relative path when unset
- `update-server/test-build-e2e.js` — end-to-end test that drives POST `/api/admin/build` (single + `all:true` with 2 customers) against a synthetic project, waits for jobs to succeed, then asserts GET `/api/admin/customers` reports `_launcherFileExists/_serverFileExists=true` and a non-null `_launcherReleased` for each built channel — the exact contract the original Task #15 bug violated

## External Dependencies

### Runtime (Launcher)
- `electron` ^31 — desktop shell
- `react` / `react-dom` ^18 — UI framework
- `vite` ^5 + `@vitejs/plugin-react` — bundler
- `tailwindcss` ^3 + `autoprefixer` / `postcss` — styling
- `framer-motion` ^11 — animations
- `zustand` ^4 — state management
- `lucide-react` ^0.441 — icons
- `react-hot-toast` ^2 — notifications
- `@fontsource/orbitron` + `@fontsource/rajdhani` — fonts
- `electron-builder` ^24 — packaging (zip + dir targets, no installer)
- `sharp` ^0.34 — PNG resizing for ICO generation
- `png-to-ico` ^3 — ICO conversion

### Runtime (Companion Server)
- `express` ^4 — HTTP API
- `bcryptjs` ^2 — password hashing
- `jsonwebtoken` ^9 — JWT auth
- `sql.js` ^1.10 — SQLite (WebAssembly, no native bindings)
- `multer` ^1 — file upload handling
- `cors` ^2 — CORS middleware

### Runtime (Update Server)
- `express` ^4 — HTTP server
- `better-sqlite3` ^12 — SQLite with WAL (native binding, faster than sql.js)
- `multer` ^2 — logo upload handling
- `cookie-parser` ^1 — session cookie parsing

### External APIs
- **IGDB API** (`api.igdb.com`) — game metadata and cover art search; requires Twitch OAuth client ID + secret (user-provided, not stored in repo)
- **DigiCert timestamp server** (`timestamp.digicert.com`) — RFC 3161 timestamps for Authenticode signing (optional, only for signed production builds)

### Infrastructure
- Self-hosted Windows RDP machine running the OTA update server on port 4231
- Windows Firewall rule added automatically by `start.bat` (requires one-time admin run)
- No cloud services required — fully self-contained