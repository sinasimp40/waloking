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
- **Streaming Services:** Sidebar tile (Netflix by default) opens the site in a popup. In Electron the popup is a sandboxed `BrowserWindow` with a unique non-persisted `session.fromPartition('streaming-…')`, `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `devTools:false`, `will-navigate`/`will-redirect` guards locking the popup to http(s), and storage cleared on close. In the browser preview it falls back to `window.open(..., 'noopener')`. Operators manage the tile list (name, icon letter or image, URL, color) from the in-launcher AdminPanel → Streaming section. Settings are stored in Zustand (schema v32, migration resets to Netflix-only **only if** the user still has the original 6 auto-seeded ids `s1..s6`; any customization is preserved as-is).
- **Netflix Auto-Login (OTA-managed cookies):** When the streaming popup target is `netflix.com`, `walok/electron/main.js` fetches per-channel cookies from `<updateServer>/updates/<channel>/netflix-cookies.json` and injects them into the popup's ephemeral session BEFORE `loadURL` — so the cafe customer lands on the "Who's Watching?" screen instead of the login form. Cookies are managed in the OTA admin per-customer: each customer card has a `🎬 Netflix` button that opens a modal where the operator pastes the JSON exported from a browser extension like "Get cookies.txt LOCALLY". Stored in the new `customers.netflix_cookies` TEXT column. Defense-in-depth: launcher only injects cookies whose domain is `netflix.com` or a subdomain, regardless of what the JSON contains. Public fetch endpoint is gated only by the channel name (same threat model as `/updates/<channel>/latest.json`); a leaked Netflix cookie = full account takeover until the operator does "Sign out of all devices" on netflix.com — this trade-off is documented in both the server code and the admin modal.

### Per-Customer Branding System
- **Configuration:** Branding details are stored in JSON files, including channel, brand name, logo, and update server information.
- **Rebranding Process:** A script automates find-and-replace operations across source files for custom branding.
- **Build Orchestration:** A script manages the entire build pipeline, from logo synchronization to packaging and publishing.
- **Brand Management:** Uses `brand.js` as a single source of truth for consistent branding and data naming.

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