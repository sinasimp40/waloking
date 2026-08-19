# Plan - Game Management Enhancements

## User Request
- Change "Software" references back to "Game" in the admin panel.
- Add path selection buttons for "System Executable Path" and "Software Variations" paths.
- Rename "Folder Location Path" to "Save and Load Folder Path".
- Allow custom game categories (instead of just a fixed dropdown).
- Add IGDB search functionality to the Games tab for easy game adding.

## Proposed Changes

### 1. Branding & Text
- Update `src/balok/components/AdminPanel.jsx` to replace "Modify Software Entry" with "Modify Game Entry" and similar labels.
- Rename "Folder Location Path" to "Save and Load Folder Path" in the form.

### 2. Path Selection
- Update the `Input` component in `src/balok/components/AdminPanelShared.jsx` or create a new `PathInput` component that includes a "Select Path" button.
- Integrate with `window.electronAPI.selectFile` or `selectFolder` (assuming these exist based on previous context about Electron integration).

### 3. Categories
- Change the category select to a searchable combobox or a text input with suggestions, allowing users to type new categories.
- Update `useStore` to optionally track a list of custom categories.

### 4. IGDB Search Integration
- Add a search button/bar in the "Games" infrastructure header that triggers an IGDB search modal.
- Implement the `IGDBSearchModal` component in `src/balok/components/IGDBSearchModal.jsx`.
- When a game is selected from IGDB, pre-fill the game form with the name, icon, and description.

## Technical Details
- **Path Selection**: Use `window.electronAPI.openFileDialog` for executable paths and `window.electronAPI.openDirectoryDialog` for save/load paths.
- **IGDB API**: Utilize the existing `/api/public/igdb/search` endpoint.
- **State Management**: Ensure `useStore` correctly persists custom categories.

## Verification Plan
- **UI Check**: Verify all text changes in the Games section.
- **Path Selection**: Mock Electron API calls in the browser to ensure the buttons trigger the expected logic.
- **Search**: Perform a test search against the IGDB endpoint and verify pre-filling logic.
- **Categories**: Add a custom category and ensure it persists and appears in the filters.
