'use strict'

const assert = require('assert')
const sharp = require('sharp')
const { createAlertCard } = require('../electron/monitor')

async function main() {
  const artwork = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#ef1234"/></svg>'
  ).toString('base64')
  const card = await createAlertCard(`data:image/svg+xml;base64,${artwork}`, {
    pcName: 'PC 12',
    gameName: 'OBS Studio',
    itemName: 'OBS Studio',
    iconText: 'W',
    alertType: 'Top App',
    timestamp: '8/29/2026, 7:47:13 PM',
  })

  const { data, info } = await sharp(card).raw().toBuffer({ resolveWithObject: true })
  const pixelOffset = ((100 * info.width) + 700) * info.channels
  assert(data[pixelOffset] > 220, 'configured data-URL artwork must appear in the card')
  assert(data[pixelOffset + 1] < 60, 'text fallback must not replace configured artwork')
  console.log('PASS: WALOK Telegram card uses configured data-URL artwork')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})