---
name: Branded Balok build intent
description: The user's Balok build requests expect the software name and icon to be preserved.
---

Treat this user's request to build Balok as a customer-branded build, not a
generic development package, unless they explicitly say otherwise.

**Why:** The user repeatedly corrected instructions that produced a launcher
missing its expected software name and icon.

**How to apply:** Verify the actual scripts and branding pipeline before giving
commands. Explain whether a build applies customer branding, which operating
system it targets, and whether it publishes an OTA update. Do not claim a
remembered command existed without evidence in the available history.
Do not present an invented example brand as the user's actual brand: use a
configured customer or ask which customer the build should use.
