# Redesign Balok Control Deck and Login

Redesign the Balok Control Deck and Login interface with a futuristic "Omni-Terminal" HUD aesthetic.

## User Review Required

> [!IMPORTANT]
> This overhaul replaces the existing gradient design with a high-tech obsidian HUD. It uses specific typography (JetBrains Mono, Syne) and a slim expanding sidebar.

- **Visual Direction**: "Omni-Terminal" — Deep obsidian backgrounds, ultra-slim nav ribbon, and technical telemetry HUD.
- **Login**: Split-screen "Air-Lock" design with scanning animations.
- **Panel**: Full-screen immersive HUD displaying system stats (CPU, Latency).

## Proposed Changes

### Design & Assets
- Update `src/routes/__root.tsx` to include JetBrains Mono, Syne, and Plus Jakarta Sans fonts.
- Store design system specs in `mem://design/omni-terminal-ui.md`.

### Component Overhaul
#### Login (`src/balok/components/AdminLogin.jsx`)
- Full rewrite to implement the split-screen layout.
- Add "cryptographic" input style with scanning bar animations.

#### Panel (`src/balok/components/AdminPanel.jsx`)
- Replace standard sidebar with a 16px navigation ribbon (expands on hover).
- Implement top-bar telemetry HUD with mock system stats.
- Create technical component variants: `Card` (corner markers), `PrimaryBtn` (fill hover), `Input` (underlined).
- Re-integrate logical sections (Library, Featured, Rates, etc.) into the new HUD structure.

## Technical Details
- **Fonts**: `@import` via root route.
- **Layout**: `100vw/100vh` fixed positioning for the panel.
- **Animations**: `framer-motion` for ribbon expansion and HUD element entry.
- **Dependencies**: None beyond existing `lucide-react` and `framer-motion`.
