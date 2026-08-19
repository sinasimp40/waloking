const DEFAULT_CLIENT_ID = "10v1tjvitc8rlqrzwlprsjgk1ukogy";
const DEFAULT_CLIENT_SECRET = "eulj0ebeyc9uh6gtatamg63l6gdknj";

type Creds = { clientId: string; clientSecret: string };

export function resolveCreds(clientId?: string, clientSecret?: string): Creds {
  return {
    clientId: clientId || process.env["IGDB_CLIENT_ID"] || DEFAULT_CLIENT_ID,
    clientSecret:
      clientSecret || process.env["IGDB_CLIENT_SECRET"] || DEFAULT_CLIENT_SECRET,
  };
}

let tokenCache: { token: string; expiresAt: number; key: string } | null = null;

export async function getToken({ clientId, clientSecret }: Creds) {
  const key = `${clientId}:${clientSecret}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    { method: "POST" },
  );
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("IGDB auth failed");
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
    key,
  };
  return data.access_token;
}

const big = (url: string, size: string) =>
  url.startsWith("//")
    ? `https:${url}`.replace("t_thumb", size)
    : url.replace("t_thumb", size);

export type IgdbGame = {
  id: number;
  name: string;
  icon: string;
  wallpaper: string;
  summary: string;
  genres: string[];
  category: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function searchGames(query: string, creds: Creds, limit = 10) {
  const token = await getToken(creds);
  // IGDB rate-limits to a few requests per second. A grid of covers fires many
  // lookups at once, so retry with backoff instead of surfacing a 500.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const isRawQuery = query.includes(';');
    const body = isRawQuery 
      ? query 
      : `search "${query.replace(/"/g, "")}"; fields name,summary,cover.url,genres.name,screenshots.url,artworks.url,game_modes.name,multiplayer_modes.onlinecoop; limit ${limit};`;

    res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": creds.clientId,
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body,
    });
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) break;
    await sleep(250 * (attempt + 1) + Math.random() * 200);
  }
  if (!res || !res.ok) {
    console.warn(`[IGDB Server] Error ${res?.status ?? "network"} for query: ${query}`);
    return [];
  }
  const rows = (await res.json()) as any[];
  return rows.map<IgdbGame>((g) => ({
    id: g.id,
    name: g.name,
    icon: g.cover?.url ? big(g.cover.url, "t_cover_big") : "",
    wallpaper:
      g.artworks?.[0]?.url || g.screenshots?.[0]?.url
        ? big(g.artworks?.[0]?.url || g.screenshots[0].url, "t_1080p")
        : "",
    summary: g.summary || "",
    genres: (g.genres || []).map((x: any) => x.name),
    category: (() => {
      const isOnline = 
        (g.genres || []).some((x: any) => 
          x.name.toLowerCase().includes('online') || 
          x.name.toLowerCase().includes('multiplayer') || 
          x.name.toLowerCase().includes('mmo')
        ) ||
        (g.game_modes || []).some((x: any) => 
          x.name.toLowerCase().includes('multiplayer') || 
          x.name.toLowerCase().includes('mmo')
        ) ||
        (g.multiplayer_modes || []).some((x: any) => x.onlinecoop === true);
      return isOnline ? 'online' : 'offline';
    })(),
  }));
}
