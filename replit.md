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
6. **Rebrand handling:** When exe name changes (e.g. `BLAST.exe` → `BLASTING.exe`), manifest includes `exeName`; updater spawns new exe and writes `.ota-cleanup.json` marker; next launch sweeps and deletes the old exe (and any Desktop/Start menu shortcuts pointing to it). **Both manifests carry exeName** — `scripts/publish-update.js` writes `exeName` into BOTH `latest.json` for the launcher channel AND `latest.json` for the `<channel>-server` channel via `computeServerExeName()` (which appends `" Server"` to the brand name to mirror electron-builder's productName → exe filename rule). Without this, the server-side `stageOutOfProcessApply()` rejected every server update at the manifest-validation gate ("manifest missing exeName"), wrote `.ota-pending/FAILED`, and never created the .bat applier — the field bug where rebranded server folders never got wiped or re-extracted. **`isSafeExeBasename` allows ASCII spaces** (mirrored in both `walok/electron/updater.js` and `walok/server/electron/updater.js`) — regex is `^[A-Za-z0-9._\- ]+\.exe$` — because the server's productName format `<brand> Server` always produces a basename with a space (e.g. `DENFIS Server.exe`). All command metacharacters (`&`, `|`, `<`, `>`, `^`, `%`, `;`, `"`, slashes, colon) remain rejected; the value flows into the .bat through quoted paths only, so allowing space introduces no shell-injection risk.
7. **Transactional in-process extract:** `extractZip` is per-file transactional. Existing targets are renamed into `.ota-pending/.ota-bak/<entry>` before overwrite; on any failure the apply path calls `rollbackExtract` to restore originals. Used on Linux/macOS only (no file locks).
8. **Out-of-process Windows applier (Task #18 — fixes the field-reported "OLD launcher keeps running, payload never extracts" bug; redesigned twice in April 2026 after follow-up field reports — first a visible cmd window + non-exiting parent, then the PowerShell rewrite ALSO failed silently with `.apply.lock` present and zero `apply.log`, meaning `powershell.exe` never executed even one line on the customer machine — most likely cause: group-policy ExecutionPolicy override or antivirus blocking the .ps1 in `%TEMP%`):** On Windows the in-process path can never overwrite `app.asar` (the running Electron process holds the lock), so `applyPendingUpdateOnStartup` takes a different path. (a) **Sweep first:** if `.ota-pending/SUCCESS` is present (a prior OOP run finished but its self-cleanup hadn't reached the dir before this boot), wipe `.ota-pending` and return — never re-apply the same payload. (b) Acquire `.ota-pending/.apply.lock` via atomic `O_CREAT|O_EXCL` — if held and <5 min old, skip; >5 min stale locks get taken over. (c) Validate `manifest.exeName` against `^[A-Za-z0-9._\- ]+\.exe$` whitelist (space allowed for the `<brand> Server.exe` server basename); resolve the actual cased name from the zip's central directory via `listTopLevelExesInZip` (no extraction). (d) **Pre-write overlay files at the pending-dir root** (no `staged/` subfolder — the brain-dead-simple "delete everything in install dir, just extract payload.zip" model the field bug demanded): `cleanup-marker.json`, `current-exe-sidecar.json`, and `merged-ota-config.json` — a version-bumped clone of the OLD `ota-config.json` that preserves customer fields (channel, customerId, updateServer) and only changes `version`. All three travel through `JSON.stringify`, no shell escaping; the `.bat` simply `copy /Y`'s them into final positions. (e) **Write a plain Windows `.bat` applier + a tiny `.vbs` hidden-launcher shim to `%TEMP%`, then spawn `wscript.exe //Nologo apply.vbs <parentPid> <installDir> <newExe>` detached.** No PowerShell anywhere in the apply path — every PowerShell-based applier we shipped failed for at least one customer (some never ran the script at all). The `.vbs` does `WScript.Shell.Run "cmd /c ""<batPath>"" <args>", 0, False` (canonical 20-year-old Windows pattern for "fire a console process truly invisibly" — windowStyle=0 is hidden, waitOnReturn=False detaches; the doubled-wrap quoting is required because `cmd /c` with >2 quotes only strips the leading + trailing ones). The `.bat` uses ONLY built-in cmd commands and Windows 10 1803+ built-in `tar.exe` for zip extraction (no PowerShell, no external tools, no policy surface). The bat: writes `apply.log` header, sleeps 4s (fixed wait — no tasklist|find PID polling, which can hang on PID reuse), wipes every file at the install-dir root EXCEPT `.ota-instance-id` and `*-settings.json` (user state), wipes every directory at root EXCEPT `.ota-pending` and `*-data` (chrome profiles etc), runs `tar -xf payload.zip -C installDir`, copies the three overlay files into place, launches the NEW exe via **`start "" /D "%INSTALL_DIR%" "%INSTALL_DIR%\%NEW_EXE%"`** (the `/D` switch was added to the SERVER bat after a follow-up field report — without an explicit working-directory the new GUI exe could fail to appear when the bat ran in a hidden VBS-spawned cmd context, especially because the server's `<brand> Server.exe` basename always contains a space; the launcher bat works without `/D` because launcher exe names have no space), then sleeps ~1s via `ping 127.0.0.1 -n 2 >NUL` so Windows can finish forking the GUI process before the hidden cmd exits, writes `SUCCESS`, and schedules a 5s-delayed `start /B cmd /c` self-cleanup that wipes `.ota-pending` and deletes both the .bat and .vbs. (f) Immediately call the exit hook (`process.exit(0)` — `app.exit` was unreliable when the updater was wired in pre-`whenReady`, which was the second field bug) so the OS releases the asar handle. Test hooks (`_forceOutOfProcess`, `_spawnFn`, `_exitFn`, `_tmpDir`, `_batScript`, `_vbsScript`) preserved on the Node side. Mirrored in both `walok/electron/updater.js` and `walok/server/electron/updater.js`. Per user instruction after the second field report, the OTA-related test files (`test-rebrand-update.js`, `test-server-rebrand.js`) were removed — the user lost trust in unit tests that pass while production keeps failing.
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
- **Electron Integration:** Runs as an Electron application with a system tray icon and a dashboard. The dashboard (`walok/server/src/dashboard.html`) embeds an OTA progress overlay that mirrors the launcher's `UpdateModal.jsx` 1:1 — same stages (`available` → `downloading` → `verifying` → `applying` → `ready`), same 5-second countdown, same RESTART NOW button. It subscribes to the same `ota:*` IPC events the server's `updater.js` already broadcasts (`broadcast()` at line 103), so no extra server-side wiring was needed. When the countdown hits 0 it invokes `serverAPI.ota.restart()` which calls `restartApp()` → `app.relaunch()` (the same path the launcher uses), so the Electron-managed relaunch mechanism handles re-spawning the OLD exe to trigger the OOP applier.

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