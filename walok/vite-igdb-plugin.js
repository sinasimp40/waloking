import https from 'https'

let cachedToken = null
let tokenExpiry = 0
let cachedClientId = null

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000,
    }

    const req = https.request(reqOptions, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch { reject(new Error('Invalid JSON response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

function igdbRequest(endpoint, body, accessToken, clientId) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'api.igdb.com',
      path: `/v4/${endpoint}`,
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'text/plain',
      },
      timeout: 10000,
    }

    const req = https.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid IGDB response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    req.write(body)
    req.end()
  })
}

async function getAccessToken(clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiry && cachedClientId === clientId) return cachedToken

  const url = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
  const data = await fetchJSON(url, { method: 'POST' })

  if (data.access_token) {
    cachedToken = data.access_token
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    cachedClientId = clientId
    return cachedToken
  }
  throw new Error(data.message || 'Failed to get access token')
}

export default function igdbPlugin() {
  return {
    name: 'vite-igdb-plugin',
    configureServer(server) {
      server.middlewares.use('/api/igdb/search', async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Method not allowed' }))
        }

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
          try {
            const { query, clientId, clientSecret } = JSON.parse(body)
            if (!clientId || !clientSecret) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              return res.end(JSON.stringify({ error: 'IGDB credentials not configured. Go to Admin Panel > Settings to add them.' }))
            }

            const token = await getAccessToken(clientId, clientSecret)
            const games = await igdbRequest('games', `search "${query}"; fields name,cover,genres,keywords,summary,category,game_modes,themes,url; limit 10;`, token, clientId)

            const coverIds = games.map(g => g.cover).filter(Boolean)
            let covers = {}
            if (coverIds.length > 0) {
              const coverData = await igdbRequest('covers', `fields game,image_id,url; where id = (${coverIds.join(',')}); limit 50;`, token, clientId)
              coverData.forEach(c => { covers[c.game] = c })
            }

            const genreIds = [...new Set(games.flatMap(g => g.genres || []))]
            let genres = {}
            if (genreIds.length > 0) {
              const genreData = await igdbRequest('genres', `fields name; where id = (${genreIds.join(',')}); limit 50;`, token, clientId)
              genreData.forEach(g => { genres[g.id] = g.name })
            }

            const keywordIds = [...new Set(games.flatMap(g => g.keywords || []))]
            let keywords = {}
            if (keywordIds.length > 0) {
              const keywordData = await igdbRequest('keywords', `fields name; where id = (${keywordIds.join(',')}); limit 100;`, token, clientId)
              keywordData.forEach(k => { keywords[k.id] = k.name })
            }

            const gameModeIds = [...new Set(games.flatMap(g => g.game_modes || []))]
            let gameModes = {}
            if (gameModeIds.length > 0) {
              const gmData = await igdbRequest('game_modes', `fields name; where id = (${gameModeIds.join(',')}); limit 50;`, token, clientId)
              gmData.forEach(gm => { gameModes[gm.id] = gm.name })
            }

            const results = games.map(g => {
              const cover = covers[g.id]
              const coverUrl = cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${cover.image_id}.jpg` : null
              const headerUrl = cover ? `https://images.igdb.com/igdb/image/upload/t_screenshot_big/${cover.image_id}.jpg` : null
              const gameGenres = (g.genres || []).map(id => genres[id]).filter(Boolean)
              const gameKeywords = (g.keywords || []).map(id => keywords[id]).filter(Boolean)
              const gameGameModes = (g.game_modes || []).map(id => gameModes[id]).filter(Boolean)
              const isOnline = gameGameModes.some(m =>
                m.toLowerCase().includes('multiplayer') ||
                m.toLowerCase().includes('multi-player') ||
                m.toLowerCase().includes('online') ||
                m.toLowerCase().includes('co-op') ||
                m.toLowerCase().includes('mmo') ||
                m.toLowerCase().includes('battle royale')
              )

              return {
                id: g.id,
                name: g.name,
                icon: coverUrl,
                header: headerUrl,
                summary: g.summary || '',
                genres: gameGenres,
                keywords: gameKeywords.slice(0, 10),
                category: isOnline ? 'online' : 'offline',
                url: g.url,
              }
            })

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, results }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message || 'IGDB request failed' }))
          }
        })
      })
    }
  }
}
