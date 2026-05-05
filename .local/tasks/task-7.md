---
title: Add a multi-process safety lock for dependency installs
---
# Add a multi-process safety lock for dependency installs

  ## What & Why
  Today the OTA server serializes `npm install` inside a single Node process via a synchronous pre-flight in `/api/admin/build`. If an operator ever runs two OTA server instances against the same project root (e.g. a primary + a hot-spare), both could install at the same time and corrupt the shared `node_modules`. Adding a filesystem-level lock (e.g. proper-lockfile on `<projectRoot>/.ota-install.lock`) closes that gap.

  ## Done looks like
  - A lockfile in `<projectRoot>` is acquired around the install pre-flight.
  - A second OTA server hitting build at the same moment waits for the lock or fails fast with a clear message.
  - Lock is released even if install crashes.

  ## Relevant files
  - `walok/update-server/server.js` (`/api/admin/build` install pre-flight, ~line 717)