// No-op stub for non-Windows builds (Linux dev / macOS). The Windows
// build uses keyblocker.cc with the real WH_KEYBOARD_LL hook.

#include <napi.h>

static Napi::Value NoOpFalse(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("enable",      Napi::Function::New(env, NoOpFalse));
  exports.Set("disable",     Napi::Function::New(env, NoOpFalse));
  exports.Set("isEnabled",   Napi::Function::New(env, NoOpFalse));
  exports.Set("hideTaskbar", Napi::Function::New(env, NoOpFalse));
  exports.Set("showTaskbar", Napi::Function::New(env, NoOpFalse));
  return exports;
}

NODE_API_MODULE(keyblocker, Init)
