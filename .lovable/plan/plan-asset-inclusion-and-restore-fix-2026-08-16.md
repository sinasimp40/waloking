# Plan - Asset Inclusion and Restore Fix

The user wants to ensure that exported backups (ZIP) include all local image assets and that importing these backups correctly restores those images, even if they come from a different computer or path.

## User Requirements
- ZIP export must include all local assets (icons, wallpapers, logos).
- ZIP import must correctly handle these assets and fix paths.
- Remove temporary test files after fixing.
- Synchronize changes to the `balok/` directory (Electron source).

## Technical Strategy
- **Export**: Enhance the `exportData` function to capture all local blobs (not just URLs) and store them in the ZIP.
- **Import**: Enhance the `handleImport` function to extract assets from the ZIP and either:
    - Save them to the local Electron filesystem (if running in Electron).
    - Or convert them to base64/blobs for the web preview.
- **Path Sanitization**: Improve `sanitizePath` to prefer local extracted assets over IGDB fallbacks if available.

## Implementation Details

### 1. Enhanced ZIP Import (`AdminPanelSections.jsx`)
- Modify `handleImport` to extract the `assets/` folder from the ZIP.
- For each asset, if running in Electron, use `window.electronAPI.saveAsset` (if it exists) to write the file to the local `assets/` directory.
- For web preview, create object URLs or data URLs for these assets and update the store to point to them.

### 2. Synchronization
- Run `rsync` to update `balok/src/` with the changes.

### 3. Cleanup
- Remove `/tmp/denfi_test` and any other temporary artifacts.

## Verification
- Verify that `JSZip` correctly extracts the `assets/` folder.
- Verify that `importState` handles the restored paths.
