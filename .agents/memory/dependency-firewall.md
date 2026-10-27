---
name: Dependency firewall recovery
description: Recovering imported npm lockfiles blocked by Replit's package firewall.
---

If updating a direct dependency still attempts to fetch a blocked transitive version, explicitly include that transitive package in the targeted npm update.

**Why:** During import setup, updating Express alone retained the blocked proxy-addr lock entry. Updating both resolved an allowed release without bypassing the firewall or changing Express major versions.

**How to apply:** Inspect the blocked package and its parent, check available releases, and update the parent and blocked transitive package together within existing version constraints. Never change registries to evade a security block.
