# Plan: Optimize Games Grid in Admin Panel

The user reported that game cards in the Admin Panel are too large, leading to excessive scrolling when many games are added. I will redesign the `GamesSection` to use a more compact, list-like grid or smaller cards with higher information density.

## User Review Required

> [!IMPORTANT]
> I am moving from a large hero-style card (aspect-video) to a more compact horizontal "Game Row" style. This allows more items to be visible on screen simultaneously while keeping the industrial aesthetic.

- Should I add a toggle to switch between "Grid" (current) and "List" (compact) views, or should I just make the default view more compact? I'll start by making the default view more compact as requested.

## Proposed Changes

### Admin Panel Redesign (`src/balok/components/AdminPanel.jsx`)

- **Shrink Game Cards**: Replace the `aspect-video` large images with a smaller, square icon/thumbnail on the left.
- **Horizontal Layout**: Arrange name, category, and configuration buttons in a row or a much smaller card.
- **Increase Column Count**: Increase the number of columns in the grid for larger screens (e.g., `grid-cols-2 md:grid-cols-3 xl:grid-cols-4`).
- **Refine Metadata**: Make descriptions more compact (or remove them from the main list view) to save vertical space.

## Technical Details

- Update `GamesSection` in `src/balok/components/AdminPanel.jsx`.
- Adjust Tailwind grid classes: `grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-8` -> `grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4`.
- Redesign the card inner structure from vertical (Image over Info) to horizontal (Icon next to Info) or just smaller vertical.
- Ensure the "Industrial" styling remains consistent.

## Verification Plan

- **Automated Check**: Run a build check to ensure no JSX errors are introduced.
- **Manual Verification**: Use the live preview to verify the games grid fits more items on the screen. I'll check the responsiveness at different screen widths.
