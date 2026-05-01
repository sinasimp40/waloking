---
title: Lock in the parallel-install safety with an automated regression test
---
# Lock in the parallel-install safety with an automated regression test

  ## What & Why
  The current safety guarantee — that two overlapping `/api/admin/build` calls on a fresh tree never run `npm install` concurrently — is only verified by code reading. An integration test that fires two overlapping requests with deps temporarily missing would prevent a future refactor from accidentally re-introducing the race.

  ## Done looks like
  - A new test file (e.g. `walok/update-server/test-build-endpoint.js`) spins the express app, points it at a temp project root with an empty `node_modules`, fires two POST /api/admin/build calls in quick succession, and asserts only one install ran.
  - The test is wired into the npm-test target.

  ## Relevant files
  - `walok/update-server/server.js` (install pre-flight)
  - `walok/update-server/test-job-runner.js` (existing test harness pattern to follow)