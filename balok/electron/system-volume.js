/* ── Real Windows system volume control ───────────────────────────────────
   PowerShell is started only for an actual volume request and exits as soon
   as that request completes. Never keep a shell attached to the launcher. */
const { execFile } = require('child_process')

const CSHARP = `
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object i); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Audio {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
"@
`

function isWindows() { return process.platform === 'win32' }

function run(script) {
  if (!isWindows()) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-Command', CSHARP + '\n' + script,
    ], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
  })
}

async function getVolume() {
  if (!isWindows()) return null
  const output = await run('Write-Output (([Audio]::Get()).ToString([Globalization.CultureInfo]::InvariantCulture) + "|" + [Audio]::GetMute())')
  if (!output) return null
  const [vol, mute] = output.split('|')
  const v = parseFloat(String(vol).replace(',', '.'))
  if (isNaN(v)) return null
  return { volume: Math.round(v * 100), muted: String(mute).toLowerCase() === 'true' }
}

function setVolume(percent) {
  if (!isWindows()) return false
  const v = Math.max(0, Math.min(100, Number(percent) || 0)) / 100
  void run(`[Audio]::Set(${v.toFixed(4)})`)
  return true
}

function setMute(muted) {
  if (!isWindows()) return false
  void run(`[Audio]::SetMute($${muted ? 'true' : 'false'})`)
  return true
}

function dispose() {}

module.exports = { getVolume, setVolume, setMute, dispose, isSupported: isWindows }
