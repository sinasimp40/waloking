# Build Balok on Windows

## Customer-branded launcher

For a launcher with a customer's software name and icon, use the OTA update
server's admin panel running on **Windows**:

1. Open `/admin/` and select the **Balok** tab.
2. Add or edit the customer and check its brand name and logo.
3. Use that customer's **Build** action, not **Build Balok (dev)**.

The customer build generates `icon.ico` from the logo and sets Electron's
product name. It also publishes the customer's OTA manifest, so it can make
the update available to installed launchers. Only build a live customer when
ready to release that version.

The current customer build targets the host operating system. Running it on
Replit's Linux host does not produce the Windows customer launcher.

There is no `npm run build:balok` command in this repository's available scripts.

## Generic development launcher

The following command does **not** apply customer branding. Its default software
name is `Launcher`; do not use it expecting a customer-named executable and logo.

Install Node.js 22, then open Command Prompt in the latest project folder:

```bat
cd balok
npm ci
npm run dist
```

Only run the build after `npm ci` finishes successfully. The Windows app is
created at `dist-electron\win-unpacked\Launcher.exe`. Keep the whole
`win-unpacked` folder together; copying only the executable will not work.

## Installation blocked by `EALLOWREMOTE`

Older project copies have a lockfile whose package downloads point to a
Lovable cache at `europe-west4-npm.pkg.dev`. The current lockfile uses the public
npm registry and preserves the same package versions and integrity hashes.

Replace `balok\package-lock.json` with the current project's copy, then retry
`npm ci`. If the terminal still mentions a Lovable URL, it is using an old copy
of the lockfile.

Alternatively, run this command inside your existing `balok` folder to correct
only the old cache URL prefix, retaining all versions and integrity hashes:

```bat
node -e "const fs=require('fs');const p='package-lock.json';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('https://europe-west4-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/','https://registry.npmjs.org/'))"
npm ci
npm run dist
```

Do not disable npm's remote-package security restrictions. If your organization
requires a particular registry, follow its registry policy instead.

`'vite' is not recognized` after a failed install means the dependencies are
missing. Fix the installation first; installing Vite globally is not necessary.

This builds the generic launcher. Customer-branded builds and OTA updates use
the update server's customer build process.
