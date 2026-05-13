// Native low-level keyboard hook for kiosk-mode lockdown.
// Installs a WH_KEYBOARD_LL system hook that swallows OS-reserved
// chords (Alt+Tab, Win key, Ctrl+Esc, Alt+F4, Alt+Esc) so the user
// cannot escape the launcher window. Ctrl+Alt+Del cannot be blocked
// from user space — Microsoft reserves that for the SAS handler.
//
// The hook is global (HMODULE = GetModuleHandle(NULL)) but does NOT
// require DLL injection because WH_KEYBOARD_LL runs in the installing
// process's thread message loop. Electron's main thread has a Chromium
// UI message loop, which is sufficient.

#include <napi.h>
#include <windows.h>

static HHOOK g_hook = NULL;

static LRESULT CALLBACK KeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION) {
    KBDLLHOOKSTRUCT* p = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    bool altDown  = (GetAsyncKeyState(VK_MENU)    & 0x8000) != 0;
    bool ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

    // Block left/right Win key (Win+anything: Win+E, Win+R, Win+D, etc.)
    if (p->vkCode == VK_LWIN || p->vkCode == VK_RWIN) return 1;
    // Block Alt+Tab and Alt+Shift+Tab
    if (altDown && p->vkCode == VK_TAB)    return 1;
    // Block Alt+Esc (cycles windows)
    if (altDown && p->vkCode == VK_ESCAPE) return 1;
    // Block Alt+F4 (close window)
    if (altDown && p->vkCode == VK_F4)     return 1;
    // Block Ctrl+Esc (opens Start menu)
    if (ctrlDown && p->vkCode == VK_ESCAPE) return 1;
  }
  return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

static Napi::Value Enable(const Napi::CallbackInfo& info) {
  if (g_hook == NULL) {
    g_hook = SetWindowsHookExW(
      WH_KEYBOARD_LL,
      KeyboardProc,
      GetModuleHandleW(NULL),
      0
    );
  }
  return Napi::Boolean::New(info.Env(), g_hook != NULL);
}

static Napi::Value Disable(const Napi::CallbackInfo& info) {
  if (g_hook != NULL) {
    UnhookWindowsHookEx(g_hook);
    g_hook = NULL;
  }
  return Napi::Boolean::New(info.Env(), true);
}

static Napi::Value IsEnabled(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_hook != NULL);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("enable",    Napi::Function::New(env, Enable));
  exports.Set("disable",   Napi::Function::New(env, Disable));
  exports.Set("isEnabled", Napi::Function::New(env, IsEnabled));
  return exports;
}

NODE_API_MODULE(keyblocker, Init)
