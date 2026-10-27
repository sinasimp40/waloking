---
name: Dependency firewall recovery
description: Recovering imported npm lockfiles blocked by Replit's package firewall.
---

If updating a direct dependency still attempts to fetch a blocked transitive version, explicitly include that transitive package in the targeted npm update.

**Why:** During import setup, updating Express alone retained the blocked proxy-addr lock entry. Updating both resolved an allowed release without bypassing the firewall or changing Express major versions.

**How to apply:** Inspect the blocked package and its parent, check available releases, and update the parent and blocked transitive package together within existing version constraints. Never change registries to evade a security block.

Distinguish a vulnerability block from npm's `EALLOWREMOTE` provenance restriction.

**Why:** On Windows, npm rejected the imported Lovable cache tarball URLs as
remote packages. Those cache URLs are not portable registry references; keeping
the exact versions and integrity hashes while normalizing their known public
package URL prefix allowed a clean installation.

**How to apply:** For `EALLOWREMOTE` involving the imported cache, use canonical
public npm URLs for those same packages. Keep remote-package restrictions enabled
and respect organization-mandated registries. Do not apply this workaround to a
package blocked for a vulnerability.
