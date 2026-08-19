# Redesign Plan - "Omni-Terminal" Aesthetic

The user finds the current "Command Core" design repetitive and uninspired. I will pivot to an **"Omni-Terminal"** aesthetic: a design that blends high-end watch craftsmanship (complex but clean) with advanced aerospace interfaces.

### Visual Concept
- **Color Palette**: Deep Obsidian (`#020202`) with a single "Active Neon" accent and "Paper White" text (`#F8F8F8`).
- **Typography**: Shift from heavy Syne to **JetBrains Mono** for technical data and **Inter** for clean labels. Use varying font weights (Thin to ExtraBold) for hierarchy instead of just large sizes.
- **Layout**: Replace the standard sidebar with a **"Circular/Orbital"** navigation concept or a **"Modular Grid"** where every element feels like a component of a physical machine.

### Proposed Changes

#### 1. Admin Login ("The Air-Lock")
- **Layout**: Centered, but instead of a card, use a **vertically split screen** (Top: Branding/Status, Bottom: Input).
- **Detail**: Add a "Scanning" line animation that moves across the input field.
- **Typography**: Mono-spaced token input for that "hacking" feel.

#### 2. Admin Panel ("The Flight Deck")
- **Sidebar**: Transform into a **slim vertical ribbon** (48px) with high-contrast icons that expand on hover into a glass-morphic overlay.
- **Main Header**: A "HUD" style header with real-time stats (Memory usage, connection status) in tiny, high-density mono text.
- **Sections**: Use **asymmetric grids**. Instead of rows, use cards with staggered heights and "exposed" corner markings.
- **Components**:
    - **Buttons**: Minimalist outlines that "fill" with color on hover.
    - **Inputs**: Underlined only, with tiny labels that float above.

### Technical Details
- Use `framer-motion` for complex transitions between tabs (sliding panels).
- Implement a custom "Scanline" CSS overlay for texture.
- Reduce font sizes further to `9px` - `12px` for that "pro instrument" look, using tracking to maintain legibility.
