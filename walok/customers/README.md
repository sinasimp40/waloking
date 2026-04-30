# Customers

Each `.json` file in this folder represents one customer / one branded build.

> ⚠️ **IMPORTANT:** `example-cafe.json` ships with a **placeholder** `updateServer`
> (`http://YOUR-RDP-IP:4231`). You **must** change this to the real public IP/hostname
> of the machine running the OTA update server **before** building, otherwise installed
> launchers will silently fail every OTA poll. The admin panel highlights customers
> with placeholder URLs in yellow and prepends a warning at the top of the build log.

## Fields

- `channel` — unique ID for this customer (used in OTA URLs, e.g., `cafe-a`, `gamerz-spot`). Letters, numbers, and dashes only.
- `brandName` — the app name shown in the launcher (e.g., `"GAMERZ SPOT"`)
- `subtitle` — small tagline shown next to the brand name
- `logo` — path (relative to repo root) to the customer's logo. **Must be `branding/<channel>-logo.<ext>`** (where `<ext>` is `png`, `jpg`, `jpeg`, `jfif`, or `webp`). Each customer needs its OWN per-channel file — the build script no longer uses a shared `branding/logo.png`. Auto-converted to `.ico` at build time.
- `updateServer` — base URL of YOUR update server (e.g., `http://203.0.113.45:4231`). All this customer's installed launchers will check this URL for updates.

## Build commands

- Build ONE customer:    `build-customer.bat example-cafe`
- Build ALL customers:   `build-all.bat`
- Publish update for one: `node scripts/publish-update.js example-cafe`
- Publish update for all: `node scripts/publish-update.js --all`

## How OTA works for a customer

1. Customer's installed launcher reads its baked-in `channel` and `updateServer` values.
2. Every 2 minutes (and at startup), launcher fetches `<updateServer>/updates/<channel>/latest.json`.
3. If the version there is newer than what's installed, the launcher downloads the payload, shows a progress bar, and prompts to restart.
4. After restart, the new version is live. Customer's branding is preserved (because they downloaded THEIR branded build).
