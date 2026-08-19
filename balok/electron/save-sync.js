// Save & Load sync — zip a game's save folder, upload it to the LAN save
// server, and download/extract it back. Ported from the walok implementation
// so Balok's Save & Load modal works instead of returning "Not implemented".
const fs = require('fs')
const path = require('path')

function registerSaveSync(ipcMain) {
  function expandEnvVars(p) {
    if (!p) return p
    return p.replace(/%([^%]+)%/g, (_, varName) => {
      return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`
    })
  }

  function collectFiles(dir, baseDir, fileList) {
    if (!fileList) fileList = []
    const items = fs.readdirSync(dir)
    for (const item of items) {
      const fullPath = path.join(dir, item)
      const relativePath = path.relative(baseDir, fullPath)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.isDirectory()) {
          collectFiles(fullPath, baseDir, fileList)
        } else {
          fileList.push({ fullPath, relativePath, size: stat.size })
        }
      } catch (e) {}
    }
    return fileList
  }

  function buildZipBuffer(files) {
    const zlib = require('zlib')
    const localHeaders = []
    const centralHeaders = []
    let offset = 0

    for (const file of files) {
      const content = fs.readFileSync(file.fullPath)
      const compressed = zlib.deflateRawSync(content)
      const nameBuffer = Buffer.from(file.relativePath.replace(/\\/g, '/'), 'utf8')

      let crc = crc32(content)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(8, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc >>> 0, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(content.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(0, 28)

      localHeaders.push(Buffer.concat([local, nameBuffer, compressed]))

      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0, 8)
      central.writeUInt16LE(8, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc >>> 0, 16)
      central.writeUInt32LE(compressed.length, 20)
      central.writeUInt32LE(content.length, 24)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(offset, 42)

      centralHeaders.push(Buffer.concat([central, nameBuffer]))
      offset += 30 + nameBuffer.length + compressed.length
    }

    const centralDirOffset = offset
    const centralDir = Buffer.concat(centralHeaders)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(centralDir.length, 12)
    eocd.writeUInt32LE(centralDirOffset, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...localHeaders, centralDir, eocd])
  }

  function crc32(buf) {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i]
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function extractZip(zipBuffer, destDir) {
    const zlib = require('zlib')
    let pos = 0

    while (pos + 4 <= zipBuffer.length) {
      const sig = zipBuffer.readUInt32LE(pos)
      if (sig !== 0x04034b50) break

      const method = zipBuffer.readUInt16LE(pos + 8)
      const compSize = zipBuffer.readUInt32LE(pos + 18)
      const uncompSize = zipBuffer.readUInt32LE(pos + 22)
      const nameLen = zipBuffer.readUInt16LE(pos + 26)
      const extraLen = zipBuffer.readUInt16LE(pos + 28)

      const nameRaw = zipBuffer.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
      const entryName = nameRaw.replace(/\//g, path.sep)
      const dataStart = pos + 30 + nameLen + extraLen
      const compData = zipBuffer.slice(dataStart, dataStart + compSize)

      pos = dataStart + compSize

      const targetPath = path.resolve(destDir, entryName)
      const normalizedDest = path.resolve(destDir) + path.sep
      if (!targetPath.startsWith(normalizedDest) && targetPath !== path.resolve(destDir)) continue

      if (entryName.endsWith('/') || entryName.endsWith('\\')) {
        fs.mkdirSync(targetPath, { recursive: true })
        continue
      }

      const parentDir = path.dirname(targetPath)
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })

      let content
      if (method === 0) {
        content = compData
      } else if (method === 8) {
        content = zlib.inflateRawSync(compData)
      } else {
        continue
      }

      fs.writeFileSync(targetPath, content)
    }
  }

  ipcMain.handle('zip-and-upload-save', async (event, savePath, gameName, serverUrl, token) => {
    try {
      const expandedPath = expandEnvVars(savePath)
      const resolvedPath = path.resolve(expandedPath)

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Save path does not exist: ' + expandedPath }
      }

      let zipBuffer
      const stat = fs.statSync(resolvedPath)
      if (stat.isDirectory()) {
        const files = collectFiles(resolvedPath, resolvedPath)
        if (files.length === 0) {
          return { success: false, error: 'Save folder is empty: ' + expandedPath }
        }
        const totalSize = files.reduce((sum, f) => sum + f.size, 0)
        if (totalSize > 200 * 1024 * 1024) {
          return { success: false, error: 'Save folder too large (' + Math.round(totalSize / 1024 / 1024) + ' MB). Max 200 MB.' }
        }
        zipBuffer = buildZipBuffer(files)
      } else {
        const content = fs.readFileSync(resolvedPath)
        const fileName = path.basename(resolvedPath)
        const zlib = require('zlib')
        const compressed = zlib.deflateRawSync(content)
        const crc = crc32(content)
        const nameBuffer = Buffer.from(fileName, 'utf8')

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(8, 8)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(compressed.length, 18)
        local.writeUInt32LE(content.length, 22)
        local.writeUInt16LE(nameBuffer.length, 26)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(8, 10)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(compressed.length, 20)
        central.writeUInt32LE(content.length, 24)
        central.writeUInt16LE(nameBuffer.length, 28)

        const eocd = Buffer.alloc(22)
        eocd.writeUInt32LE(0x06054b50, 0)
        eocd.writeUInt16LE(1, 8)
        eocd.writeUInt16LE(1, 10)
        const centralLen = 46 + nameBuffer.length
        const centralOff = 30 + nameBuffer.length + compressed.length
        eocd.writeUInt32LE(centralLen, 12)
        eocd.writeUInt32LE(centralOff, 16)

        zipBuffer = Buffer.concat([local, nameBuffer, compressed, central, nameBuffer, eocd])
      }

      const http = require('http')
      const https = require('https')
      const urlModule = require('url')

      const boundary = '----BalokBoundary' + Date.now()
      const sanitizedGameName = (gameName || '').trim().slice(0, 200)

      const preamble = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="gameName"\r\n\r\n${sanitizedGameName}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="saveName"\r\n\r\ndefault\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="save.zip"\r\nContent-Type: application/zip\r\n\r\n`
      )
      const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`)
      const body = Buffer.concat([preamble, zipBuffer, epilogue])

      const parsed = urlModule.parse(serverUrl + '/api/saves')
      const mod = parsed.protocol === 'https:' ? https : http

      const result = await new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.path,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Authorization': `Bearer ${token}`
          },
          timeout: 120000
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid response from server')) }
          })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')) })
        req.write(body)
        req.end()
      })

      if (result.success) {
        return { success: true }
      }
      return { success: false, error: result.error || 'Upload failed' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-and-extract-save', async (event, saveId, savePath, serverUrl, token) => {
    try {
      const http = require('http')
      const https = require('https')
      const urlModule = require('url')

      const sanitizedId = String(saveId).replace(/[^0-9]/g, '')
      if (!sanitizedId) return { success: false, error: 'Invalid save ID' }

      const parsed = urlModule.parse(`${serverUrl}/api/saves/${sanitizedId}/download`)
      const mod = parsed.protocol === 'https:' ? https : http

      const zipBuffer = await new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.path,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 120000
        }, (res) => {
          if (res.statusCode !== 200) {
            let body = ''
            res.on('data', chunk => body += chunk)
            res.on('end', () => {
              try {
                const err = JSON.parse(body)
                reject(new Error(err.error || 'Download failed'))
              } catch {
                reject(new Error('Download failed: ' + res.statusCode))
              }
            })
            return
          }
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => resolve(Buffer.concat(chunks)))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')) })
        req.end()
      })

      const expandedPath = expandEnvVars(savePath)
      const resolvedSavePath = path.resolve(expandedPath)
      if (!fs.existsSync(resolvedSavePath)) {
        fs.mkdirSync(resolvedSavePath, { recursive: true })
      }

      extractZip(zipBuffer, resolvedSavePath)

      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerSaveSync }
