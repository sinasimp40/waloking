# WALOK — Multi-Customer Game Launcher with OTA Update System

## Overview
WALOK is a system designed for internet cafes and gaming lounges to manage and distribute custom-branded game launchers. It enables the creation and deployment of Electron + React launchers that receive over-the-air (OTA) updates from a self-hosted Express server. The system supports managing an unlimited number of customers from a single web administration panel, providing a streamlined solution for brand customization and software distribution with business vision to simplify game launcher management for multiple clients.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components
- **Launcher:** A customizable Electron + React application for end-users.
- **Companion Server:** An Electron application offering a local REST API for game save management and user authentication.
- **OTA Update Server:** An Express server with an administration panel for publishing and distributing updates to launchers.

### Launcher (Frontend + Electron Shell)
- **Technology Stack:** React 18, Vite 5, TailwindCSS 3, Framer Motion, Zustand.
- **UI/UX Design:** Cyberpunk aesthetic using Orbitron and Rajdhani fonts.
- **Electron Integration:** Secure `electronAPI` bridge for renderer process communication.
- **Distribution:** Portable ZIP format, no installation required.
- **Integrity Protection:** Verifies application integrity at startup.

### Kiosk Mode
- **Construction-time fullscreen:** When `settings.kioskMode` is true at boot, the BrowserWindow is created with `fullscreen: true, kiosk: true, alwaysOnTop: true, skipTaskbar: true` directly in the constructor. Toggling fullscreen on a frameless window AFTER creation is unreliable on Windows 11 (taskbar stays visible until user clicks); creating the window already-fullscreen forces Windows to perform real exclusive-fullscreen at construction so the very first paint hides the taskbar.
- **Auto-restart on enable:** Toggling kiosk OFF→ON in the admin panel awaits an explicit `saveSettings` ACK (real disk write) then calls `app:restart` IPC → `app.relaunch() + app.exit(0)`. The relaunched process reads `kioskMode=true` from disk and constructs the window in fullscreen state. A generation counter cancels the in-flight restart if the user toggles kiosk again before the save completes.
- **Native key blocker (`walok/electron/native/keyblocker`):** A C++ N-API addon that installs a `WH_KEYBOARD_LL` low-level keyboard hook on Windows. Swallows Alt+Tab, Alt+Shift+Tab, Win key (L/R), Ctrl+Esc, Alt+Esc, Alt+F4 at the OS level so those chords never reach the OS shell. Ctrl+Alt+Del cannot be blocked from user space (Microsoft reserves it for the SAS handler). The addon is built via `node-gyp` + `@electron/rebuild` (run `npm run rebuild:native` after install or any Electron version change). Falls back to no-op stubs on non-Windows / when build tools are missing — kiosk window state still applies but OS chords are not blocked.
- **Auto-close on launch:** Kiosk implies auto-close behavior — when the user launches a game while kiosk is on, the launcher closes after a 1s delay regardless of the separate `autoCloseOnLaunch` toggle. The OR check `(settings.autoCloseOnLaunch || settings.kioskMode)` lives in `Sidebar.jsx` (Top Picks / Social / Office) and `GameCard.jsx`.
- **Emergency exit:** `Ctrl+Shift+Alt+K` registered via `globalShortcut` only while kiosk is active. Triggers `applyKiosk(false)` which tears down the keyblocker hook, drops fullscreen + alwaysOnTop + skipTaskbar, and restores the normal frameless-maximized window.

### Per-Customer Branding System
- **Configuration:** Branding details are stored in JSON files, including channel, brand name, logo, and update server information.
- **Rebranding Process:** A script automates find-and-replace operations across source files for custom branding.
- **Build Orchestration:** A script manages the entire build pipeline, from logo synchronization to packaging and publishing.
- **Brand Management:** Uses `brand.js` as a single source of truth for consistent branding and data naming.
- **Path Migration:** On startup, `migrateLegacyPaths()` renames old-brand folders/files to the current brand. When BOTH the old and new path exist (e.g., user rebrands DENFI → DENFIS → back to DENFI, leaving stale `denfi-data` next to the populated `denfis-data`), the migrator inspects the new target — if it's an empty folder or a default-sized config file, it backs the new one up as `<name>.bak.<timestamp>` and adopts the legacy folder/file as the canonical data. The outer loop iterates by SUFFIX so only the newest matching legacy is adopted per suffix (no race between e.g. `denfis-data` and older `walok-data`). After folder renames, `migrateJsonContents()` walks the settings/config JSON and rewrites any path-like string values that reference old brand slugs (e.g., `denfi-assets` → `denfi2-assets`). Only strings containing path separators or `file:` prefixes are touched — non-path data like game names/descriptions is left untouched.

### OTA Update Flow
- **Update Mechanism:** Launchers poll the update server and utilize Server-Sent Events (SSE) for real-time notifications.
- **Update Application:** New versions are downloaded, verified (SHA-256), staged, and applied upon application restart.
- **Rebump Detection:** Each build is stamped with a unique `buildId` baked into `ota-config.json` by `build-customer.js` and re-emitted into the OTA manifest by `publish-update.js`. The launcher and server `checkForUpdate` paths pull when `manifest.buildId !== local.buildId` even if `version` is unchanged, so same-version republishes ("rebumps") trigger an OTA pull on both launcher and server clients. Downgrades are blocked: rebump pull only fires on exact version match, never when remote is older.
- **Windows Updater:** A `.bat` applier spawned by a `.vbs` shim handles out-of-process updates, ensuring transactional integrity and avoiding file locks.
- **Executable Management:** Manages executable renaming and cleanup of old files and shortcuts.
- **Concurrency Control:** Prevents multiple instances of the launcher or server.
- **Font Rendering:** Ensures custom fonts load before UI rendering to prevent flickering.

### OTA Update Server
- **Backend:** Express 4 with `better-sqlite3`.
- **Authentication:** Cookie-based session authentication with bcrypt.
- **Admin Panel:** Static HTML interface for managing customers and builds, featuring a "premium dark" aesthetic.
- **Build Job System:** Supports concurrent, isolated builds with real-time log streaming via SSE and a queuing system for job management. Includes a structured phase model for progress tracking.
- **Live Registry:** Tracks connected launcher and server instances.
- **Source Management:** Operators can upload project source zips; updates are atomic and preserve operator-managed state. Real-time progress bars are provided for uploads.
- **Dependency Management:** Allows pre-installation of project dependencies independently of a full build.

### Companion Server
- **Backend:** Express 4 with `sql.js` (SQLite).
- **Authentication:** bcryptjs for password hashing and JWT for token-based authentication.
- **Features:** User registration, login, save file upload/download, and user-isolated folder management.
- **Electron Integration:** Runs as an Electron app with a system tray icon and a dashboard that mirrors OTA update progress.
- **UDP Auto-Discovery:** On startup the server broadcasts a UDP beacon every 3s on port 19777 containing `{service, ip, port, hostname}`. The launcher listens on the same port and auto-fills the Save & Load Server URL when a matching beacon is received. Uses `rinfo.address` (real sender IP) instead of trusting payload IP to prevent spoofing. Beacon is skipped if the server is bound to loopback only. Discovery files: `walok/server/electron/discovery.js` (beacon), `walok/electron/discovery.js` (listener).

### Build Scripts
- **Rebranding Script:** Handles comprehensive source tree rebranding.
- **Customer Build Script:** Manages the build pipeline for individual customers.
- **Build All Script:** Iterates and builds all defined customer configurations.
- **Publish Update Script:** Creates update manifests and copies build artifacts.
- **Collect Builds Script:** Gathers and verifies final build artifacts.

## External Dependencies

### Runtime (Launcher)
- **Electron:** Desktop shell.
- **React, React-DOM:** UI framework.
- **Vite:** Frontend build tool.
- **TailwindCSS, Autoprefixer, PostCSS:** CSS framework.
- **Framer Motion:** Animation library.
- **Zustand:** State management.
- **Lucide-React:** Icon library.
- **React-Hot-Toast:** Notification library.
- **@fontsource/orbitron, @fontsource/rajdhani:** Custom fonts.
- **Electron-Builder:** Application packaging.
- **Sharp, Png-To-Ico:** Image processing.

### Runtime (Companion Server)
- **Express:** Web application framework.
- **Bcryptjs:** Password hashing.
- **Jsonwebtoken:** JWT authentication.
- **Sql.js:** SQLite database.
- **Multer:** `multipart/form-data` handling.
- **CORS:** Cross-Origin Resource Sharing.

### Runtime (Update Server)
- **Express:** Web application framework.
- **Better-SQLite3:** SQLite database.
- **Multer:** `multipart/form-data` handling.
- **Cookie-Parser:** Cookie parsing.

### External APIs
- **IGDB API (api.igdb.com):** Game metadata and cover art search.
- **DigiCert Timestamp Server (timestamp.digicert.com):** For RFC 3161 timestamps during Authenticode signing.

### Infrastructure
- **Self-hosted Windows RDP machine:** Required for the OTA update server.
- **Windows Firewall:** Automatically configured.
- **No cloud services:** Entirely self-contained.