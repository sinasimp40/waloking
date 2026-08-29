---
name: Windows OTA safety
description: Non-obvious invariants for safely replacing packaged Electron apps while preserving customer state.
---

An OTA package must be rejected before installation unless its executable bytes match the packaged integrity manifest. After extraction, verify the installed pair again and require the new process to acknowledge successful startup before deleting rollback data.

**Why:** Windows locks running Electron files, so an interrupted or partial replacement can leave an old executable beside new resources. Also, archive entries with leading `./` or Win32-normalized trailing dots/spaces can bypass naive protected-path checks and overwrite retained customer state.

**How to apply:** Canonicalize archive paths using Win32 rules before protected-state checks, back up replaceable application files while excluding persisted data/config, restore on extraction/hash/startup failure, and only mark an update successful after a token-bound startup acknowledgement.

When multiple branded server-data directories coexist, select the richest valid database/save tree only after scanning all candidates, back up a displaced target, and leave nonselected legacy trees untouched.