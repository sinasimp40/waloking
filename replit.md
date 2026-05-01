# WALOK — Multi-Customer Game Launcher with OTA Update System

## Overview
WALOK is a system for internet cafes and gaming lounges to distribute and manage branded game launchers. It enables the creation and deployment of custom-branded Electron + React launchers that receive over-the-air (OTA) updates from a self-hosted Express server. The system supports managing an unlimited number of customers from a single web administration panel, providing a streamlined solution for brand customization and software distribution.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components
- **Launcher:** A customizable Electron + React application.
- **Companion Server:** An Electron application providing a local REST API for managing game saves and user authentication.
- **OTA Update Server:** An Express server with an admin panel for publishing and distributing updates.

### Launcher (Frontend + Electron Shell)
- **Technology Stack:** React 18, Vite 5, TailwindCSS 3, Framer Motion, Zustand.
- **Design:** Cyberpunk aesthetic using Orbitron and Rajdhani fonts.
- **Electron Integration:** Secure `electronAPI` bridge for renderer process communication.
- **Distribution:** Portable ZIP, no installation wizard required.
- **Integrity Protection:** Verifies application integrity at startup.

### Per-Customer Branding System
- **Configuration:** Branding defined in JSON files (channel, brand name, logo, update server details).
- **Rebranding Process:** Script performs find-and-replace operations across source files.
- **Build Orchestration:** Script manages the build pipeline from logo sync to packaging and publishing.
- **Logo Isolation:** Ensures correct application of customer-specific logos.
- **Brand Management:** Single source of truth for branding via `brand.js` for easier rebrands and consistent data naming conventions.

### OTA Update Flow
- **Update Mechanism:** Launchers poll the update server and use Server-Sent Events (SSE) for instant push notifications.
- **Update Application:** New versions are downloaded, verified (SHA-256), staged, and applied on the next application restart.
- **Executable Renaming:** Handles changes in executable names and cleans up old executables/shortcuts.
- **Windows Updater:** Utilizes a plain Windows `.bat` applier spawned by a `.vbs` shim for out-of-process updates, ensuring transactionality and avoiding file locks.
- **Single Instance Lock:** Prevents multiple instances of the launcher or server from running concurrently.
- **Font Rendering:** Ensures custom fonts are loaded before UI rendering to prevent flickering.

### OTA Update Server
- **Backend:** Express 4 with `better-sqlite3`.
- **Authentication:** Cookie-based session authentication with bcrypt.
- **Admin Panel:** Static HTML interface for managing customers and builds, featuring a "premium dark" aesthetic.
- **Build Job System:** Supports concurrent, isolated builds with real-time log streaming via SSE, and a queue for managing jobs. Features a structured phase model for detailed progress tracking.
- **Live Registry:** Tracks connected launcher and server instances.
- **Source Management:** Operators can upload entire project source zips or individual launcher/server source zips for building. Source updates are atomic and preserve operator-managed state. Uploads display a real-time byte-level progress bar (driven by `XMLHttpRequest.upload.onprogress`, since `fetch()` does not expose upload progress in browsers), then transition to an "Extracting + swapping…" indicator while the server processes the zip on disk.
- **Dependency Management:** Provides an "Install Now" button to pre-install project dependencies without initiating a full build.

### Companion Server
- **Backend:** Express 4 with `sql.js` (SQLite).
- **Authentication:** bcryptjs for password hashing and JWT for token-based authentication.
- **Features:** User registration/login, save file upload/download, user-isolated folder management.
- **Electron Integration:** Runs as an Electron app with a system tray icon and a dashboard mirroring OTA update progress.

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

## Recent Changes

### 2026-05-01 — UX cleanup: hide "OTA" text + compact, searchable Customers panel
- **Launcher + companion server:** removed the user-facing "OTA" word from the
  launcher update modal kicker (`walok/src/components/UpdateModal.jsx`) and
  the in-game companion server's update overlay (`walok/server/src/dashboard.html`).
  The kicker now shows just the brand name (or "Update" when no brand is set).
  All remaining "OTA" mentions are in code comments only. The admin panel
  intentionally still uses "OTA SYSTEM" as it is operator-only.
- **Admin Customers panel** (`update-server/public/admin/`):
  - Cards are now more compact: column min/max shrunk from `320px–460px`
    to `240px–320px`, gap from 14 → 12, card padding from 18 → 14.
  - List has `max-height:70vh; overflow-y:auto` so even a long list never
    pushes the rest of the admin UI off-screen.
  - New toolbar above the grid: search input + result count badge.
  - New pagination footer below the grid (page size 12; only shown when
    >1 page of matches).
  - Search is case-insensitive on `channel`, `brandName`, and `subtitle`,
    debounced 150 ms; Enter forces immediate render, Escape clears.
  - Empty-state ("No customers match …") includes a Clear button.
  - When a delete drops the customer count to 0, the toolbar/search state
    is fully reset so a stale filter can never hide newly-added customers.
- **Verification:** `update-server` test suite still 10/10 green; e2e
  Playwright run confirmed login → search "zzznomatch" → empty state →
  Clear → search "example" → customer card visible. Architect review:
  PASS, no high/severe defects.