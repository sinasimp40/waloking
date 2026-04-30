# WALOK — Multi-Customer Game Launcher with OTA Update System

## Overview
WALOK is a system designed for internet cafes and gaming lounges to distribute branded game launchers. It enables the creation and deployment of per-customer branded Electron + React launchers that receive over-the-air (OTA) updates from a self-hosted Express server. The system supports managing an unlimited number of customers from a single web administration panel, providing a streamlined solution for brand customization and software distribution.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components
- **Launcher:** An Electron + React application, built uniquely for each customer with custom branding.
- **Companion Server:** An Electron application providing a local REST API for managing game saves and user authentication within each cafe.
- **OTA Update Server:** An Express server hosting builds and an admin panel, responsible for publishing and distributing updates.

### Launcher (Frontend + Electron Shell)
- **Technology Stack:** React 18, Vite 5, TailwindCSS 3, Framer Motion, Zustand.
- **Design:** Uses Orbitron and Rajdhani fonts for a cyberpunk aesthetic.
- **Electron Integration:** Features a secure `electronAPI` bridge for renderer process communication.
- **Distribution:** Distributed as a portable ZIP, requiring no installation wizard or administrative privileges.
- **Integrity Protection:** Incorporates a mechanism to verify the application's integrity at startup, preventing tampering.

### Per-Customer Branding System
- **Configuration:** Each customer's branding is defined in a JSON file, including channel, brand name, logo, and update server details.
- **Rebranding Process:** A script performs a comprehensive find-and-replace operation across source files to inject custom branding elements.
- **Build Orchestration:** A dedicated script manages the entire build pipeline, from logo synchronization and rebranding to Vite compilation, Electron-builder packaging, artifact collection, and publishing.
- **Logo Isolation:** Ensures that customer-specific logos are correctly applied and isolated during the build process.
- **Legacy Migration:** Includes mechanisms to manage and migrate user data folders from older installations during updates.

### OTA Update Flow
1. Launcher reads baked-in `ota-config.json` (channel, updateServer URL, version)
2. **SSE live push** (`electron/ota-live.js`): Long-lived GET to `/api/live/:channel/:role/:instance` — server pushes `{type:'update'}` instantly when admin publishes
3. **HTTP poll fallback** (`electron/updater.js`): every 2 min fetches `/updates/<channel>/latest.json`
4. If newer version: download ZIP payload, verify SHA-256, stage to `.ota-pending/`, show progress modal
5. On restart: extract staged ZIP over install folder BEFORE React loads, delete staging dir, continue
6. **Rebrand handling:** When exe name changes (e.g. `BLAST.exe` → `BLASTING.exe`), manifest includes `exeName`; updater spawns new exe and writes `.ota-cleanup.json` marker; next launch sweeps and deletes the old exe (and any Desktop/Start menu shortcuts pointing to it)
7. **Transactional in-process extract:** `extractZip` is per-file transactional. Existing targets are renamed into `.ota-pending/.ota-bak/<entry>` before overwrite; on any failure the apply path calls `rollbackExtract` to restore originals. Used on Linux/macOS only (no file locks).
8. **Out-of-process Windows applier (Task #18 — fixes the field-reported "OLD launcher keeps running, payload never extracts" bug; redesigned April 2026 after a follow-up field report that the cmd window was visible and the parent never exited):** On Windows the in-process path can never overwrite `app.asar` (the running Electron process holds the lock), so `applyPendingUpdateOnStartup` takes a different path. (a) **Sweep first:** if `.ota-pending/SUCCESS` is present (a prior OOP run finished but its self-cleanup hadn't reached the dir before this boot), wipe `.ota-pending` and return — never re-apply the same payload. (b) Acquire `.ota-pending/.apply.lock` via atomic `O_CREAT|O_EXCL` — if held and <5 min old, skip; >5 min stale locks get taken over. (c) Validate `manifest.exeName` against `^[A-Za-z0-9._-]+\.exe$` whitelist; resolve the actual cased name from the zip's central directory via `listTopLevelExesInZip` (no extraction). (d) **Pre-write overlay files at the pending-dir root** (no `staged/` subfolder — the brain-dead-simple "delete everything in install dir, just extract payload.zip" model the field bug demanded): `cleanup-marker.json` (PowerShell renames to `.ota-cleanup.json`), `current-exe-sidecar.json` (renamed to `.ota-current-exe.json`), and `merged-ota-config.json` — a version-bumped clone of the OLD `ota-config.json` that preserves customer fields (channel, customerId, updateServer) and only changes `version`. All three travel through `JSON.stringify`, no shell escaping. (e) Write `apply.ps1` to `%TEMP%` and spawn **`powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File apply.ps1 -ParentPid … -PendingDir … -InstallDir … -NewExe …`** detached + windowsHide + stdio:ignore. PowerShell with `-WindowStyle Hidden` reliably hides the console; `cmd.exe`'s `windowsHide` did not. (f) Immediately call the exit hook (`process.exit(0)` — `app.exit` was unreliable when the updater was wired in pre-`whenReady`, which was the second field bug) so the OS releases the asar handle. The PS applier then polls `Get-Process -Id $ParentPid` and compares `StartTime` against the value captured at script start (defeats PID reuse — `cmd.exe`'s `tasklist | find PID` could hang forever on a recycled PID), waits 3s grace, runs `Expand-Archive -LiteralPath payload.zip -DestinationPath $InstallDir -Force` (with up to 5 retries × 2s backoff for transient locks), copies the three overlay files into place, launches the NEW exe via `Start-Process`, writes `SUCCESS`, and schedules a 5s-delayed background cleanup that wipes the pending dir and deletes the script itself. PowerShell args are bound through `param()` — no string interpolation of user content into commands. Test hooks (`_forceOutOfProcess`, `_spawnFn`, `_exitFn`, `_tmpDir`, `_ps1Script`) let the Linux test runner exercise the staging path, args contract, pre-written overlay file contents, lock semantics, the exeName whitelist, and the SUCCESS-sweep early-out. Covered by `tests/test-rebrand-update.js` (116 assertions including the new SUCCESS-sweep scenario) and `tests/test-server-rebrand.js` (58 assertions). Mirrored in both `walok/electron/updater.js` and `walok/server/electron/updater.js`.
- **Update Mechanism:** Launchers poll the update server periodically and maintain a Server-Sent Events (SSE) connection for instant push notifications of new versions.
- **Update Application:** New versions are downloaded, verified (SHA-256), staged, and applied on the next application restart.
- **Executable Renaming:** Handles changes in executable names during updates, ensuring proper cleanup of old executables and shortcuts.

### OTA Update Server
- **Backend:** Express 4 with `better-sqlite3` for database management, storing customer and metadata.
- **Authentication:** Cookie-based session authentication with bcrypt-hashed passwords.
- **Admin Panel:** A static HTML interface for managing customers and builds.
- **Build Job System:**
    - Supports concurrent builds with isolation, running in dedicated workspaces.
    - Child processes are launched at below-normal OS priority to maintain server responsiveness.
    - Serializes jobs for the same channel to prevent conflicts.
    - Provides real-time log streaming to the admin panel via SSE.
    - Implements a queue for jobs exceeding concurrency limits.
- **Live Registry:** Tracks connected launcher and server instances, displaying online/offline status and versions in the admin panel.
- **Cleanup:** Automatically removes older build versions after successful updates.
- **Install Lock:** Uses a cross-process filesystem lock to safeguard against concurrent `npm install` operations, ensuring build integrity.
- **SSE Log Coalescing:** Optimizes SSE log streaming by buffering and flushing events to improve performance.
- **Per-Build Progress Bar (Task #17):** Each running build is rendered in the admin panel as a compact card with a labelled orange progress bar (replacing the verbose console scroller), an mm:ss elapsed timer, and a collapsible log (collapsed by default, auto-expanded on failure). Backed by a structured phase model in `update-server/phases.js`:

  | id              | label                       | weight |
  |-----------------|-----------------------------|--------|
  | `workspace`     | Preparing workspace         | 0.02   |
  | `rebrand`       | Rebranding source           | 0.03   |
  | `vite`          | Vite production build       | 0.08   |
  | `pack-launcher` | Packing launcher payload    | 0.36   |
  | `pack-server`   | Packing server payload      | 0.36   |
  | `collect`       | Collecting artifacts        | 0.05   |
  | `publish`       | Publishing to update server | 0.10   |

  Weights sum to 1.0. `phases.js` exports `PHASES`, `SUBSTEP_TO_PHASE` (build-customer.js substep label → phase id), `phaseById(id)`, and `weightSoFar(id)` (cumulative weight of preceding phases).

  **Wire format** — at every phase boundary the job-runner pushes a structured event onto the same `job.output` ring buffer that holds log lines, then broadcasts it to all SSE listeners. The client distinguishes phase events from log events by the presence of a `phase` field. Shape:
  ```ts
  type PhaseEvent = {
    t: number;            // ms since epoch (server clock)
    phase: string;        // phase id, e.g. "pack-launcher"
    label: string;        // human label, e.g. "Packing launcher payload"
    weight: number;       // 0..1 — this phase's weight
    weightSoFar: number;  // 0..1 — cumulative weight of preceding phases
    startedAt: number;    // ms since epoch when this phase began
  }
  ```
  `jobEmitPhase()` is idempotent per phase id within a job (re-emitting the same phase is a no-op so the bar never jumps backwards). Phase events live alongside log lines in `job.output`, so the existing SSE replay path naturally rehydrates the bar position on a mid-build page refresh (Task #10 contract preserved).

  **Phase event sources** — three places emit phase events: (1) the runner itself fires `workspace` before allocating the workspace clone; (2) `[SUBSTEP_BEGIN]` log markers printed by `scripts/build-customer.js` are intercepted by `processLineForSubsteps` and mapped to `rebrand`/`vite`/`pack-launcher`/`pack-server`/`collect` via `SUBSTEP_TO_PHASE`; (3) a `phase: 'publish'` field on the publish step in `server.js`'s `enqueueOneCustomerJob` fires at step entry — necessary because the publish step is a single child process with no substep markers.

  **Snapshot rehydration** — `listJobs()` exposes `currentPhase`, `currentPhaseLabel`, `currentPhaseWeight`, `currentPhaseWeightSoFar` (alongside the existing `startedAt`). `admin.js`'s `renderQueue` synthesises a `PhaseEvent` from those snapshot fields and feeds it to `setProgressFromPhase`, so a refreshed page shows the correct phase + non-zero bar position immediately — even when the original phase event has fallen out of the 5000-entry output ring buffer for a very chatty build. The mm:ss elapsed timer is also seeded from `j.startedAt` so it stays wall-clock accurate after refresh.

  **Client UI behaviour** (`public/admin/admin.js`) — `setProgressFromPhase` jumps the bar to `weightSoFar` then "creeps" toward `weightSoFar + 0.95*weight` with an asymptotic curve over `weight * BUILD_TOTAL_ETA_SEC` seconds (default 90s total) so a long phase never looks frozen; the 0.95 stop-short ensures every new phase event still produces a visible step-up. Failed builds turn the bar red, freeze it at the failing phase, auto-expand the log, and show the error banner. Cancelled builds turn the bar muted gray and freeze at the last position. The CLEAR FINISHED button + multi-card grid from Task #15 are unchanged.

### Companion Server
- **Backend:** Express 4 with `sql.js` (SQLite in-memory, persisted to file) for data storage.
- **Authentication:** bcryptjs for password hashing and JWT for token-based authentication.
- **Features:** User registration/login, save file upload/download, and user-isolated folder management.
- **Electron Integration:** Runs as an Electron application with a system tray icon and a dashboard.

### Build Scripts
- **Rebranding Script:** Handles comprehensive source tree rebranding, including string replacements, app IDs, storage keys, and ICO generation.
- **Customer Build Script:** Manages the build pipeline for individual customers, including retry logic for common Windows errors.
- **Build All Script:** Iterates and builds all defined customer configurations.
- **Publish Update Script:** Creates update manifests, including SHA-256 hashes and executable names, and copies build artifacts to the update server.
- **Collect Builds Script:** Gathers and verifies final build artifacts.

## External Dependencies

### Runtime (Launcher)
- **Electron:** Desktop shell for cross-platform application.
- **React, React-DOM:** UI framework.
- **Vite, @vitejs/plugin-react:** Frontend build tool.
- **TailwindCSS, Autoprefixer, PostCSS:** CSS framework and processing.
- **Framer Motion:** Animation library.
- **Zustand:** State management library.
- **Lucide-React:** Icon library.
- **React-Hot-Toast:** Notification library.
- **@fontsource/orbitron, @fontsource/rajdhani:** Custom fonts.
- **Electron-Builder:** Application packaging.
- **Sharp, Png-To-Ico:** Image processing for ICO generation.

### Runtime (Companion Server)
- **Express:** Web application framework.
- **Bcryptjs:** Password hashing.
- **Jsonwebtoken:** JWT authentication.
- **Sql.js:** SQLite database (WebAssembly).
- **Multer:** Middleware for handling `multipart/form-data`.
- **CORS:** Cross-Origin Resource Sharing middleware.

### Runtime (Update Server)
- **Express:** Web application framework.
- **Better-SQLite3:** SQLite database with native bindings.
- **Multer:** Middleware for handling `multipart/form-data` (for logo uploads).
- **Cookie-Parser:** Middleware for parsing cookies.

### External APIs
- **IGDB API (api.igdb.com):** For game metadata and cover art search, accessed via a Vite plugin that handles proxying and OAuth token caching. Requires user-provided Twitch OAuth credentials.
- **DigiCert Timestamp Server (timestamp.digicert.com):** Used for RFC 3161 timestamps during optional Authenticode signing.

### Infrastructure
- **Self-hosted Windows RDP machine:** Required to run the OTA update server on port 4231.
- **Windows Firewall:** Automatically configured by the `start.bat` script (requires one-time admin execution).
- **No cloud services:** The system is entirely self-contained.