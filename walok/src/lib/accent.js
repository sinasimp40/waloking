const HARD_FALLBACK = '#ff6a00'

export function getDefaultAccent() {
  if (typeof window === 'undefined' || !document?.documentElement) return HARD_FALLBACK
  try {
    const root = document.documentElement
    const inline = root.style.getPropertyValue('--accent').trim()
    if (inline) {
      const sheet = readStylesheetAccent()
      return sheet || HARD_FALLBACK
    }
    const v = getComputedStyle(root).getPropertyValue('--accent').trim()
    return v || HARD_FALLBACK
  } catch (e) {
    return HARD_FALLBACK
  }
}

function readStylesheetAccent() {
  try {
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }
      if (!rules) continue
      for (const rule of rules) {
        if (rule.selectorText === ':root' && rule.style) {
          const v = rule.style.getPropertyValue('--accent').trim()
          if (v) return v
        }
      }
    }
  } catch (e) {}
  return null
}
