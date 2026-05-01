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

### 2026-05-01 (later) — Premium Customers card + per-customer OTA toggle + filter chips
- **Per-customer "receive OTA updates" toggle:**
  - `db.js`: new `updates_enabled INTEGER` column added via `ensureColumns`
    migration (NULL ⇒ enabled, preserves backward compatibility for
    existing rows). `rowToCustomer` exposes a coerced `updatesEnabled:
    boolean`. New `setUpdatesEnabled(channel, enabled)` helper writes a
    single column without touching any other field.
  - `server.js`:
    - New gate route `GET /updates/:channelOrServer/latest.json` mounted
      **before** the static `/updates` mount. It strips an optional
      `-server` suffix to find the customer; when `updatesEnabled === false`
      it returns `404 + Cache-Control: no-store`. When the customer is
      missing or enabled, it falls through to the static handler unchanged
      (so existing 404s for missing manifests still happen normally).
    - New endpoint `POST /api/admin/customers/:channel/updates-enabled`
      (admin auth) accepts `{ enabled: boolean }`, returns `{ ok, customer }`.
- **Premium card redesign** (`admin.css`, `admin.js`, `index.html`):
  - Status accent strip across the top of every card (orange = default,
    green-gradient = has-shipped, amber = has-warning, gray = is-disabled),
    drawn via `.customer-card::before` so existing layout is unchanged.
  - New header row `.cc-header` with a brand title + monospaced channel
    pill on the left and an iOS-style switch on the right (`.cc-toggle`
    + `.cc-switch`) that shows the receive-updates state at a glance and
    flips it with one click. Disabled cards dim to 0.72 opacity.
  - New two-column versions row `.cc-versions` with mini-cards per role
    (Launcher = orange left border, Server = blue), each showing the
    current version + download link + rebump pill (when applicable).
  - Compact `.cc-meta` lines (Subtitle / Server / Logo / Last release)
    with truncation + hover tooltip for long values.
  - Cleaner `.cc-action-bar` separator; existing button data-actions
    (`edit`, `build`, `build-launcher`, `build-server`, `delete`)
    preserved so all downstream JS keeps working.
- **Filter chips** (`#customer-filters`): new All · With updates · No
  updates yet · Updates disabled chip bar between the search toolbar and
  the grid. `state.customerFilter` (default `'all'`) is combined with the
  existing search via `_filteredCustomers()`. The empty-state message and
  Clear button now also reset the active filter.
- **Frontend toggle handler** (`handleCustomerAction('toggle-updates')`):
  POSTs the new endpoint, optimistically marks the toggle `.is-busy`,
  merges the server-returned customer back into local state (preserving
  derived `_launcherVersion` / `_placeholderUrl` runtime fields), then
  re-renders the list so the card class + chip filtering re-evaluate.
- **Verification:**
  - `node --check` clean on all modified files.
  - Curl: `latest.json` is `200` while enabled, then `404 Cache-Control:
    no-store` on **both** `/updates/<ch>/latest.json` and
    `/updates/<ch>-server/latest.json` after toggling off, then `200`
    again after toggling on.
  - `npm test` still 10/10 green.
  - e2e Playwright run: login → verified `.cc-header` / `.cc-toggle` /
    `.cc-versions` / `.cc-action-bar` structure → exercised all 4 filter
    chips (including the `.customer-empty` state when "With updates" hides
    the only card) → toggled the card off (gained `.is-disabled`) →
    confirmed it shows under "Updates disabled" → toggled back on →
    reloaded page → state persisted. PASS, no verification gaps.
- **Post-review security fixes** (architect flagged HIGH; both fixed):
  - Gate route was naively stripping `-server` before DB lookup, which
    let a customer whose channel itself ends in `-server` (e.g.
    `old-server`) bypass its own kill-switch. Now does an EXACT lookup
    first and only falls back to the suffix-stripped lookup when the
    literal channel doesn't exist. Verified end-to-end with a synthetic
    customer named `old-server`: 200 enabled → 404 disabled.
  - Gate route used to fall through to `next()` on any DB read error,
    fail-OPENing the kill-switch. Now logs and returns
    `503 Cache-Control: no-store` so the launcher (which treats !=200 as
    "no update") safely stalls rather than leaking a manifest to a
    disabled customer.
  - Added `:focus-visible` outline on `.cc-toggle` (uses --accent-ring,
    matching the form-field focus style) for keyboard-only users.

### 2026-05-01 (polish round) — Card visual richness + balanced action bar
After live operator feedback ("too dry" + "buttons not balanced — Delete
drops to its own row" + "looks like an overlay issue on the file-missing
warning"), the customer card was tightened up:
- **Brand initial avatar** (`.cc-avatar`): each card now leads with a 38px
  rounded-square badge showing the first letter of the brand name. The
  background gradient is picked from an 8-palette set hashed off the
  channel string (orange / blue / emerald / violet / pink / teal / amber /
  red), so every customer is instantly visually distinct without the
  operator having to upload a logo. Stable across reloads (deterministic
  hash). Header layout is now `[avatar | name + channel pill] —
  [On/Off switch]` with center alignment.
- **Version mini-card hierarchy fix:** the `[file missing — rebuild]`
  warning used to be inlined on the same line as `v1.0.0` with
  `white-space: nowrap`, which truncated to "[file miss…" and looked
  like overlay corruption. Each `.cc-vbox` now has three rows:
  `.cc-vbox-head` (label + status dot), `.cc-vbox-version` (just the
  version number), and `.cc-vbox-status` (download link / file-missing
  warning / rebump pill — wraps freely, no overlap).
- **At-a-glance status dot** (`.cc-vbox-dot`): tiny 7px circle in each
  mini-card header — green-with-glow when a payload is shipped, amber
  when version is recorded but the payload zip is missing (publish
  crashed mid-way), faint gray when nothing is published yet.
- **Balanced action bar**: replaced the wrap-overflow flex layout (where
  Delete was orphaned on a second row) with an explicit 3×2 CSS grid:
  - Row 1: `[ Edit ] [ ⚡ Build (spans 2 cols, primary CTA) ]`
  - Row 2: `[ Launcher ] [ Server ] [ Delete ]`
  - All buttons same height, full-cell width, no wrapping. The Build
    button gets a subtle gradient + soft orange glow shadow so the
    operator's eye lands on it first.
- **Visual polish**: subtle top-down inner gradient on `.cc-vbox` so the
  mini-cards look slightly inset, plus a hover border-color change for
  micro-feedback on the version cards.
- **Verification**: e2e Playwright run reverified end-to-end and asserted
  the new layout via getBoundingClientRect — Build's left edge starts
  where Edit's right edge ends, Build's right edge aligns with Delete's
  right edge, Launcher and Server are vertically stacked with Edit and
  Build, Delete is on row 2 col 3, and no button wraps to a 3rd row.
  10/10 npm tests still green.