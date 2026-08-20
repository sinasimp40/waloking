// What the launcher does with itself as soon as a game/app launch is requested.
//
// - Auto-Close ON            → close the launcher (frees RAM, classic cafe flow)
// - Auto-Close OFF + kiosk   → minimize instead: the kiosk window is
//   always-on-top fullscreen, so staying up would bury the game the user
//   just launched. Minimizing keeps the launcher running so the user can
//   Alt+Tab back to it.
// - Auto-Close OFF, no kiosk → do nothing (launcher stays visible).
//
// The two toggles are independent — kiosk no longer forces auto-close.
export function afterGameLaunch({ autoCloseOnLaunch, kioskMode }) {
  const api = window.electronAPI
  if (!api) return
  if (autoCloseOnLaunch && api.closeWindow) {
    api.closeWindow()
  } else if (kioskMode && api.minimizeWindow) {
    api.minimizeWindow()
  }
}
