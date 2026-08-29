import assert from 'node:assert/strict'
import { createGameLaunchPayload } from '../src/lib/gameLaunchPayload.js'

const payload = createGameLaunchPayload(
  { name: 'OBS Studio', icon: 'W', iconUrl: 'data:image/png;base64,configured-artwork' },
  'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  {},
  null,
  'Top App'
)

assert.equal(payload.iconPath, 'data:image/png;base64,configured-artwork')
assert.equal(payload.iconText, 'W')
console.log('PASS: BALOK Top App payload prefers configured iconUrl artwork')