---
name: Launch card imagery
description: Rules for rendering Telegram launch-card artwork without changing configured icon backgrounds.
---

Preserve the configured source artwork when it is opaque. Only omit the card's added artwork panel when the source contains genuinely transparent pixels.

**Why:** This preserves intentional icon backgrounds while allowing transparent logos and icons to blend naturally into the VIP card.

**How to apply:** Check image alpha values rather than assuming all PNGs are transparent; do not automatically remove white or opaque artwork backgrounds.