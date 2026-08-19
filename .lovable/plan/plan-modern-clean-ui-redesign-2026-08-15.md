# Plan: Modern Clean UI Redesign

Redesign the Balok admin panel and login screen from the "Cyber-Noir HUD" aesthetic to a modern, clean, and professional "Modern Dark" style. This will focus on improved readability, softer visuals, and a more balanced layout.

## User Preferences
- **Style:** Modern looking, good for the eyes (not overly futuristic).
- **Typography:** Balanced font sizes (avoiding extremely big or small fonts).
- **Visuals:** Clean, professional, premium feel without the technical "HUD" overlays and intense neon.

## Proposed Changes

### 1. Style & Theming
- Change background from deep obsidian (`#020202`) to a softer charcoal/neutral dark (`#0f172a` or `#0a0a0a`).
- Remove "futuristic" overlays: `bg-scanline`, radial dot patterns, and technical HUD-style borders.
- Replace technical borders (`border-white/5`) with slightly more defined but subtle borders or soft shadows.
- Simplify accent color usage: move away from "Active Neon" to a more refined branding color with consistent application.

### 2. Typography
- Standardize on **Inter** or **Plus Jakarta Sans** for almost everything.
- Remove **JetBrains Mono** and **Syne** (which contributed to the "futuristic" look).
- Standardize font sizes:
  - Headers: `text-2xl` or `text-3xl` (down from `text-6xl/8xl` and `text-4xl`).
  - Body: `text-sm` or `text-base` (up from `text-[8px]` or `text-[9px]`).
  - Labels: `text-xs font-semibold` (up from `text-[7px]`).
- Remove aggressive letter-spacing (`tracking-[0.5em]`).

### 3. Component Updates (`AdminPanelShared.jsx`)
- **`SectionTitle`**: Simplified layout. Remove "Active Sub-Protocol" tag.
- **`Panel` / `Card`**: Softer corners (`rounded-xl` instead of sharp corners). Remove "HUD" corner decorations.
- **`PrimaryBtn`**: Solid background with hover effects, removing the "filling" animation.
- **`Input`**: Standard boxed inputs with clear focus states instead of the underline-only HUD style.

### 4. Layout Updates
- **`AdminLogin.jsx`**: A more centered, clean layout. Split screen or centered card.
- **`AdminPanel.jsx`**: 
  - Sidebar: A standard modern sidebar with clear labels and icons.
  - Header: Clean title area without "Core CPU" or "Sync Latency" technical stats.
  - Spacing: Consistent padding and margins for better white space usage.

## Technical Details
- Update `src/balok/components/AdminPanelShared.jsx` to redefine the primitives.
- Update `src/balok/components/AdminPanel.jsx` and `src/balok/components/AdminLogin.jsx` to use the new layout.
- Clean up `src/balok/components/AdminPanelSections.jsx` to remove HUD-specific terminology (e.g., "Monetary Protocols" -> "Pricing & Rates").
- Update `src/router.tsx` or `__root.tsx` if specific fonts need removal/addition (keeping Inter and Plus Jakarta).
