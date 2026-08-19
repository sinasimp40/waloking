# Continuous Integration

## Tamper Protection Test (`.github/workflows/tamper-test.yml`)

Runs on every pull request targeting `main` and on every push to `main`.

The job:

1. Checks out the repository on a `windows-latest` runner.
2. Installs Node.js 20 and the launcher dependencies (`npm ci`).
3. Builds the launcher installer (`npm run dist`).
4. Builds the server installer (`npm run dist:server`, which also installs
   `server/`'s dependencies).
5. Runs `node scripts/integrity-tamper-test.js`, which launches each unpacked
   `.exe`, flips a byte, expects integrity failure (exit 1 + dialog marker),
   restores the byte, and re-verifies a clean launch.

Code-signing is intentionally disabled in CI
(`CSC_IDENTITY_AUTO_DISCOVERY=false`) so unsigned installers are produced —
this is enough for the integrity regression test, and avoids needing to put
production signing certs in CI secrets.

If the tamper test fails, it uploads a `tamper-test-diagnostics` artifact
containing the electron-builder logs from both `dist-electron/` directories
to help debug the regression.

## Making the job required

The YAML alone does not block a merge — that is a repository-side setting.
To enforce it:

1. Go to **Settings → Branches → Branch protection rules** for `main`.
2. Add or edit the rule for `main`.
3. Enable **Require status checks to pass before merging**.
4. Search for and select the check named
   **`Build installers and run tamper test`** (the `name:` of the job in
   `.github/workflows/tamper-test.yml`).
5. Save the rule.

Once enabled, GitHub will not allow a pull request to be merged into `main`
until the tamper-test job has completed successfully.
