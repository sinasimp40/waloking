import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

const BalokApp = lazy(() => import("../balok/App.jsx"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Velvet Aurora Game Launcher" },
        {
          name: "description",
          content:
            "Game launcher: browse the library, track favourites and manage the cafe from the admin panel.",
        },
        { property: "og:title", content: "Game Launcher" },
        {
          property: "og:description",
          content:
            "Game launcher: browse the library, track favourites and manage the cafe from the admin panel.",
        },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    document.documentElement.classList.add("balok-app");
    document.body.classList.add("app-ready");
    return () => {
      document.documentElement.classList.remove("balok-app");
      document.body.classList.remove("app-ready");
    };
  }, []);

  return (
    <ClientOnly fallback={<div className="min-h-screen bg-void-950" />}>
      <Suspense fallback={<div className="min-h-screen bg-void-950" />}>
        <BalokApp />
      </Suspense>
    </ClientOnly>
  );
}
