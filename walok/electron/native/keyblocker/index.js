// Loader for the native keyblocker addon. Falls back to no-op stubs if
// the addon isn't built (e.g. running `npm run electron:dev` on a dev
// machine without electron-rebuild having run for the current Electron
// ABI). Kiosk mode then degrades to the focus-snap fallback in main.js.

let mod = null;
let loadError = null;

if (process.platform === 'win32') {
  try {
    mod = require('./build/Release/keyblocker.node');
  } catch (e) {
    loadError = e;
    try {
      // electron-rebuild sometimes outputs to a different path
      mod = require('./build/Debug/keyblocker.node');
      loadError = null;
    } catch (e2) {
      loadError = e2;
    }
  }
}

module.exports = {
  available: !!mod,
  loadError: loadError ? loadError.message : null,
  enable:      () => (mod ? mod.enable()      : false),
  disable:     () => (mod ? mod.disable()     : false),
  isEnabled:   () => (mod ? mod.isEnabled()   : false),
  hideTaskbar: () => (mod ? mod.hideTaskbar() : false),
  showTaskbar: () => (mod ? mod.showTaskbar() : false),
};
