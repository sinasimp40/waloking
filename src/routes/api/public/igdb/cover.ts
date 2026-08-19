import { createFileRoute } from "@tanstack/react-router";
import { resolveCreds, searchGames } from "@/lib/igdb.server";

const coverCache = new Map<string, string>();

export const Route = createFileRoute("/api/public/igdb/cover")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name")?.trim();
        if (!name) return new Response("Missing name", { status: 400 });

        try {
          let target = coverCache.get(name);
          if (!target) {
            console.log(`[IGDB Proxy] Looking up: "${name}"`);
            
            // If the name is purely numeric, it might be an IGDB ID or a timestamp
            if (/^\d+$/.test(name)) {
              // Try as direct ID first
              const results = await searchGames(`fields cover.url; where id = ${name};`, resolveCreds(), 1);
              if (results?.[0]?.icon) {
                target = results[0].icon;
              } else {
                // If not an ID, it might be a timestamp-based filename (e.g. 1785...) 
                // We can't search by timestamp, so we skip and let 404 happen or fallback to search if we had a string
              }
            }

            if (!target) {
              const results = await searchGames(name, resolveCreds(), 5);
              const hit =
                results.find(
                  (r) => r.icon && r.name.toLowerCase().includes(name.toLowerCase()),
                ) || results.find((r) => r.icon);
              if (hit?.icon) target = hit.icon;
            }

            if (!target) {
              // Final fallback: if it's a timestamp, just return a transparent pixel or 404 to avoid 500
              return new Response("Not found", { status: 404 });
            }
            coverCache.set(name, target);
          }
          
          const img = await fetch(target);
          if (!img.ok) return new Response("Upstream error", { status: 502 });
          return new Response(img.body, {
            headers: {
              "Content-Type": img.headers.get("content-type") || "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
            },
          });
        } catch (e) {
          console.error(`[IGDB Proxy Error] ${name}:`, e);
          return new Response(
            e instanceof Error ? e.message : "Cover lookup failed",
            { status: 404 }, // Use 404 instead of 500 to keep the UI clean
          );
        }
      },
    },
  },
});
