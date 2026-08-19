# Code Signing Guide

_Last reviewed: 2026-04-17. CA pricing, validation timelines, and SmartScreen
behaviour change over time — re-check vendor pages before each renewal._

This guide explains how to obtain, install, and renew a Windows code-signing
certificate for the launcher and server installers produced by `build.bat`.

> **Unsigned builds still work for development.** If you do not set
> `CSC_LINK` / `CSC_KEY_PASSWORD`, the build completes normally and produces
> an unsigned `.exe`. Windows will display an "Unknown publisher" SmartScreen
> warning to end users, but the installer is otherwise functional. Signing is
> only required for production distribution.

> **Why the integrity hook is registered on both `afterPack` and `afterSign`.**
> Signing modifies the `.exe` (it appends an Authenticode certificate
> blob), so the SHA-256 hash recorded in `resources/integrity.dat` must be
> taken AFTER signing. But when no certificate is configured, electron-builder
> skips signing entirely and `afterSign` never fires. To handle both cases,
> `scripts/integrity-postpack.js` is wired to both events in
> `package.json` and `server/package.json`. Each invocation generates a
> fresh per-build secret and rewrites the manifest, so calling it twice on
> a signed build is safe — the post-sign run wins, and its hash matches the
> final shipped binary.

---

## 1. Choose a Certificate Authority (CA)

Buy a **Windows Authenticode** code-signing certificate from a trusted CA.
Common options (any of these are accepted by Windows out of the box):

| CA          | Notes |
|-------------|-------|
| **DigiCert**  | Most expensive, fastest validation, best support. |
| **Sectigo** (formerly Comodo) | Mid-range price, widely used, often resold cheaper through partners (e.g. SSLs.com, K Software, Codegic). |
| **SSL.com**   | Competitive pricing, supports cloud-based signing (eSigner). |
| **GlobalSign** | Enterprise-friendly, good for organisations that already buy other certs from them. |
| **Certum**    | Cheapest option for individual / open-source developers (look for the "Open Source" cert). |

Resellers usually sell the exact same Sectigo / DigiCert cert at a lower
price — there is no quality difference, only support tier.

## 2. OV vs EV — which one?

| | **OV (Organisation Validation)** | **EV (Extended Validation)** |
|-|-|-|
| Price (per year) | ~$200 – $400 | ~$300 – $600 |
| Delivery | Software file (`.pfx`) you can copy anywhere | Hardware token (USB) or cloud HSM — key cannot be exported |
| SmartScreen warning on first install | **Yes — stays until your signature builds reputation** (hundreds to thousands of installs) | **No — clean install from day one** |
| Validation effort | Business documents + phone callback | Stricter: legal entity verification, in-person/notarised documents |
| CI/CD friendliness | Easy — just upload the `.pfx` as a secret | Harder — needs USB token forwarding, a cloud signing service (Azure Key Vault, SSL.com eSigner, DigiCert KeyLocker), or a dedicated signing machine |

**Recommendation:**
- Pick **EV** if you ship to end-users who must not see scary warnings,
  and you can budget for a cloud signing service or a dedicated build box.
- Pick **OV** if you want a frictionless `.pfx`-in-CI setup and can tolerate
  SmartScreen warnings for the first few weeks/months while reputation builds.

## 3. After purchase — generating / receiving the `.pfx`

- **OV:** the CA gives you a `.pfx` (or you generate a CSR, receive the cert,
  and export it to `.pfx` from the Windows Certificate Store with the
  private key included). Set a strong password during export.
- **EV:** the CA ships a USB token (SafeNet, YubiKey FIPS, etc.) or
  provisions a cloud key. There is **no exportable `.pfx`** — see
  "EV signing in CI" below.

## 4. Securely storing the `.pfx`

- Treat the `.pfx` like a production private key. Anyone with the file
  **and** the password can sign software as you.
- Store the master copy in a password manager / secrets vault
  (1Password, Bitwarden, Vaultwarden, AWS Secrets Manager, etc.).
- Never commit the `.pfx` or its password to git.
- On the build machine, keep the `.pfx` outside the repo
  (e.g. `C:\secrets\codesign.pfx`) with NTFS permissions restricted to the
  build user.
- Keep an offline backup (encrypted USB drive in a safe) so you can
  re-sign if the build machine dies before renewal.

## 5. Using the certificate locally

`build.bat` already reads the two standard electron-builder env vars.
Set them in the same shell session **before** running `build.bat`:

```bat
set CSC_LINK=C:\secrets\codesign.pfx
set CSC_KEY_PASSWORD=your-pfx-password
build.bat
```

`CSC_LINK` may also be:
- a `file://` URL,
- an `https://` URL to a private location, or
- a base64-encoded string of the `.pfx` contents (handy for CI).

When `CSC_LINK` is set, the script prints `[OK] CSC_LINK is set - installer
will be SIGNED.` Both the launcher installer (`npm run dist`) and the server
installer (`npm run dist:server`) pick up the same env vars and produce
signed `.exe` files. The signing config in `package.json` /
`server/package.json` already requests SHA-256 and timestamps via
`http://timestamp.digicert.com`, so signatures remain valid after the cert
itself expires.

## 6. Using the certificate in CI

### OV (`.pfx` file)

1. Base64-encode the `.pfx` once locally:
   ```bash
   # Linux (GNU coreutils)
   base64 -w0 codesign.pfx > codesign.pfx.b64

   # macOS (BSD base64 — no -w flag)
   base64 -i codesign.pfx -o codesign.pfx.b64

   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) `
       | Set-Content codesign.pfx.b64
   ```
2. Store two CI secrets:
   - `CSC_LINK` = contents of `codesign.pfx.b64`
   - `CSC_KEY_PASSWORD` = the `.pfx` password
3. Expose them as environment variables to the build job. electron-builder
   detects the base64 form automatically and writes a temporary `.pfx`.

### EV (hardware token / cloud key)

A `.pfx` does not exist, so `CSC_LINK` cannot be used directly. Pick one:
- **Self-hosted Windows runner** with the USB token plugged in. Configure
  electron-builder to call `signtool.exe` with the token's CSP via
  `win.signingHashAlgorithms` + a custom `sign` script.
- **Cloud signing service** (Azure Trusted Signing, SSL.com eSigner,
  DigiCert KeyLocker, GlobalSign Atlas). These provide a small CLI that
  replaces `signtool`; wire it in through the `win.sign` hook in
  `package.json`.
- Document whichever path you choose here when you adopt EV.

## 7. Yearly renewal checklist

Code-signing certificates are typically issued for 1–3 years. About
**4 weeks before expiry**:

1. **Re-validate with the CA.** Most CAs offer a "renewal" flow that
   reuses your existing organisation validation; otherwise you redo the
   OV/EV checks. Allow 1–2 weeks for EV.
2. **Receive the new cert.**
   - OV: export a fresh `.pfx` (new password) from the Windows Cert Store.
   - EV: the CA re-keys the existing token or ships a new one.
3. **Update the secrets:**
   - Replace the master copy in your password manager / vault.
   - Update `CSC_LINK` and `CSC_KEY_PASSWORD` (or the base64 form) in
     every CI environment that builds installers.
   - Update the local `.pfx` on each build machine.
4. **Test before expiry.** Run `build.bat` end-to-end with the new cert
   and verify the resulting `.exe` with:
   ```powershell
   Get-AuthenticodeSignature .\Release\Nextreme-Gaming-Hub-Setup.exe
   ```
   The status must be `Valid` and the `SignerCertificate.NotAfter` must
   reflect the new expiry.
5. **Securely destroy the old `.pfx`** once the new one is in production
   (shred / `cipher /w` the file, remove from password manager history).
6. **Calendar reminder:** add a new reminder ~11 months out for the next
   renewal.

> Because the build uses an RFC 3161 timestamp server, installers signed
> with the **old** cert remain trusted by Windows even after that cert
> expires — you only need the new cert to sign **new** builds.
