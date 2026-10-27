import assert from 'node:assert/strict'
import { getGameVariations } from '../src/lib/gameVariations.js'
import { createGameLaunchPayload } from '../src/lib/gameLaunchPayload.js'

assert.deepEqual(getGameVariations({}), [])
assert.deepEqual(getGameVariations({ variations: 'invalid' }), [])
const variations = getGameVariations({
  variations: [
    { label: 'Modern', path: 'C:\\Games\\modern.exe' },
    { name: 'Legacy', exePath: 'C:\\Games\\legacy.exe' },
    { label: 'Missing path' },
    { path: 'C:\\Games\\unnamed.exe' },
    { label: 'Blank', path: ' ' },
    null,
  ],
})
assert.equal(variations.length, 2)
assert.deepEqual(variations.map(v => [v.label, v.path]), [
  ['Modern', 'C:\\Games\\modern.exe'],
  ['Legacy', 'C:\\Games\\legacy.exe'],
])
for (const variation of variations) {
  const payload = createGameLaunchPayload({ name: 'Test Game' }, variation.path, {}, variation.label)
  assert.equal(payload.exePath, variation.path)
  assert.equal(payload.variation, variation.label)
  assert.equal(payload.gameName, 'Test Game')
}
console.log('PASS: current/legacy variations, invalid entries, and Electron launch payloads')
