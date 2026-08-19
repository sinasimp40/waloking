import { createFileRoute } from "@tanstack/react-router";
import { resolveCreds, searchGames } from "@/lib/igdb.server";

export const Route = createFileRoute("/api/public/igdb/search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            query?: string;
            clientId?: string;
            clientSecret?: string;
          };
          if (!body.query?.trim()) {
            return Response.json({ error: "Missing query" }, { status: 400 });
          }
          const results = await searchGames(
            body.query.trim(),
            resolveCreds(body.clientId, body.clientSecret),
          );
          return Response.json({ results });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "IGDB search failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
