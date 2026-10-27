// Accept current admin records and older imported launcher configurations.
export function getGameVariations(game) {
  return (Array.isArray(game?.variations) ? game.variations : []).flatMap(variation => {
    const label = variation?.label || variation?.name
    const path = variation?.path || variation?.exePath
    if (typeof label !== 'string' || !label.trim() || typeof path !== 'string' || !path.trim()) return []
    return [{ ...variation, label, path, name: label, exePath: path }]
  })
}
